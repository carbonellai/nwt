import fs from "node:fs";
import path from "node:path";
import { absFromRel, git, pathExists } from "./git";
import { loadManifest, saveManifest } from "./manifest";
import { syncOverlay } from "./overlay";
import { pathsFor, type HostPaths } from "./paths";
import { nestedGitDir, nestedWorkTree } from "./relocate";
import type { Manifest, NestedRepo } from "./types";

export const SKIP_PRUNE_ENV = "NWT_SKIP_PRUNE";

let inFlightByRoot = new Map<string, Promise<Manifest>>();

export function skipPrune(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKIP_PRUNE_ENV] === "1";
}

export async function withSkipPrune<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env[SKIP_PRUNE_ENV];
  process.env[SKIP_PRUNE_ENV] = "1";
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[SKIP_PRUNE_ENV];
    else process.env[SKIP_PRUNE_ENV] = prev;
  }
}

export function overlayUnderPrefix(overlayPath: string, nestedPath: string): boolean {
  return overlayPath === nestedPath || overlayPath.startsWith(`${nestedPath}/`);
}

export function parseWorktreePaths(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) out.push(line.slice("worktree ".length).trim());
  }
  return out;
}

export async function listUmbrellaWorktrees(cwd: string): Promise<string[]> {
  const result = await git(["worktree", "list", "--porcelain"], { cwd, allowFail: true });
  const listed = parseWorktreePaths(result.stdout);
  if (listed.length > 0) return listed;
  return [path.resolve(cwd)];
}

export function findGitDirCandidates(umbrellaWorktrees: string[], gitDirRel: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const wt of umbrellaWorktrees) {
    const abs = absFromRel(wt, gitDirRel);
    if (!pathExists(abs)) continue;
    const key = path.resolve(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

export async function resolveSharedNestedRoot(paths: HostPaths): Promise<string> {
  const fromEnv = process.env.ROOT_WORKTREE_PATH;
  if (fromEnv && pathExists(path.join(fromEnv, ".nwt", "git"))) return fromEnv;
  const umbrella = await listUmbrellaWorktrees(paths.root);
  for (const wt of umbrella) {
    const store = path.join(wt, ".nwt", "git");
    if (!pathExists(store)) continue;
    try {
      if (fs.readdirSync(store).some((name) => name.endsWith(".git"))) return wt;
    } catch {
      continue;
    }
  }
  if (pathExists(paths.gitStore)) return paths.root;
  return umbrella[0] ?? paths.root;
}

function sameResolved(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

async function nestedWorktreePaths(gitDir: string): Promise<string[]> {
  const result = await git(["worktree", "list", "--porcelain"], { gitDir, allowFail: true });
  if (result.code !== 0) return [];
  return parseWorktreePaths(result.stdout);
}

async function gitDirHasLiveCheckout(gitDir: string): Promise<boolean> {
  await git(["worktree", "prune"], { gitDir, allowFail: true });
  const listed = await nestedWorktreePaths(gitDir);
  for (const wt of listed) {
    if (sameResolved(wt, gitDir)) continue;
    if (pathExists(wt)) return true;
  }
  return false;
}

function nestedFolderExists(umbrellaWorktrees: string[], nestedRel: string): boolean {
  for (const wt of umbrellaWorktrees) {
    if (pathExists(nestedWorkTree(wt, nestedRel))) return true;
  }
  return false;
}

async function gitDirStillNeeded(
  umbrellaWorktrees: string[],
  gitDir: string,
  nestedRel?: string,
): Promise<boolean> {
  if (nestedRel && nestedFolderExists(umbrellaWorktrees, nestedRel)) return true;
  return gitDirHasLiveCheckout(gitDir);
}

async function forgetNestedWorktree(gitDir: string, dest: string): Promise<void> {
  if (!pathExists(gitDir)) return;
  await git(["worktree", "remove", "--force", dest], { gitDir, allowFail: true });
  await git(["worktree", "prune"], { gitDir, allowFail: true });
}

async function deleteGitDirIfUnused(
  umbrellaWorktrees: string[],
  gitDirRel: string,
  nestedRel?: string,
): Promise<void> {
  const candidates = findGitDirCandidates(umbrellaWorktrees, gitDirRel);
  for (const gitDir of candidates) {
    if (await gitDirStillNeeded(umbrellaWorktrees, gitDir, nestedRel)) continue;
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

async function nestedPathForGitDir(umbrellaWorktrees: string[], gitDirRel: string): Promise<string | undefined> {
  for (const wt of umbrellaWorktrees) {
    const manifest = loadManifest(pathsFor(wt));
    const entry = manifest.nested.find((item) => item.gitDir === gitDirRel);
    if (entry) return entry.path;
  }
  return undefined;
}

async function pruneUnusedGitDirs(paths: HostPaths, remaining: NestedRepo[]): Promise<void> {
  const umbrella = await listUmbrellaWorktrees(paths.root);
  const seen = new Set<string>();
  for (const wt of umbrella) {
    const store = path.join(wt, ".nwt", "git");
    if (!pathExists(store)) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(store);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".git")) continue;
      const abs = path.join(store, name);
      const key = path.resolve(abs);
      if (seen.has(key)) continue;
      seen.add(key);
      const gitDirRel = `.nwt/git/${name}`;
      const nestedRel =
        remaining.find((entry) => entry.gitDir === gitDirRel)?.path ??
        (await nestedPathForGitDir(umbrella, gitDirRel));
      if (await gitDirStillNeeded(umbrella, abs, nestedRel)) continue;
      fs.rmSync(abs, { recursive: true, force: true });
    }
  }
}

async function commitPrune(paths: HostPaths, droppedOverlay: string[]): Promise<void> {
  const specs = [...new Set([".gitignore", ...droppedOverlay])];
  await git(["add", "--", ".gitignore"], { cwd: paths.root, allowFail: true });
  const dirty = await git(["diff", "--cached", "--quiet", "--", ...specs], {
    cwd: paths.root,
    allowFail: true,
  });
  if (dirty.code === 0) return;
  await git(["commit", "-m", "nwt: prune missing nested", "--", ...specs], {
    cwd: paths.root,
    allowFail: true,
  });
}

export async function pruneEntries(
  paths: HostPaths,
  missing: NestedRepo[],
  opts: { commit?: boolean } = {},
): Promise<Manifest> {
  const manifest = loadManifest(paths);
  if (missing.length === 0) {
    await pruneUnusedGitDirs(paths, manifest.nested);
    return loadManifest(paths);
  }

  const missingPaths = new Set(missing.map((entry) => entry.path));
  const droppedOverlay = manifest.overlay.paths.filter((overlayPath) =>
    missing.some((entry) => overlayUnderPrefix(overlayPath, entry.path)),
  );
  const kept = manifest.nested.filter((entry) => !missingPaths.has(entry.path));
  const umbrella = await listUmbrellaWorktrees(paths.root);
  const nestedRoot = await resolveSharedNestedRoot(paths);

  for (const entry of missing) {
    const dest = nestedWorkTree(paths.root, entry.path);
    const gitDirs = findGitDirCandidates(umbrella, entry.gitDir);
    const gitDir = gitDirs[0] ?? nestedGitDir(nestedRoot, entry.gitDir);
    await forgetNestedWorktree(gitDir, dest);
    await deleteGitDirIfUnused(umbrella, entry.gitDir, entry.path);
  }

  manifest.nested = kept;
  manifest.overlay.paths = manifest.overlay.paths.filter(
    (overlayPath) => !missing.some((entry) => overlayUnderPrefix(overlayPath, entry.path)),
  );
  saveManifest(paths, manifest);

  if (droppedOverlay.length > 0) {
    await git(["rm", "--cached", "-f", "--ignore-unmatch", "--", ...droppedOverlay], {
      cwd: paths.root,
      allowFail: true,
    });
  }

  await syncOverlay(paths, manifest, { commit: false, nestedRoot });
  await pruneUnusedGitDirs(paths, kept);
  if (opts.commit !== false) await commitPrune(paths, droppedOverlay);
  return loadManifest(paths);
}

async function pruneOnce(paths: HostPaths, opts: { commit?: boolean }): Promise<Manifest> {
  if (skipPrune()) return loadManifest(paths);
  const manifest = loadManifest(paths);
  const missing = manifest.nested.filter((entry) => !pathExists(nestedWorkTree(paths.root, entry.path)));
  return pruneEntries(paths, missing, opts);
}

export async function pruneMissingNested(
  paths: HostPaths,
  opts: { commit?: boolean } = {},
): Promise<Manifest> {
  if (skipPrune()) return loadManifest(paths);
  const key = path.resolve(paths.root);
  const existing = inFlightByRoot.get(key);
  if (existing) return existing;
  const pending = pruneOnce(paths, opts).finally(() => {
    inFlightByRoot.delete(key);
  });
  inFlightByRoot.set(key, pending);
  return pending;
}
