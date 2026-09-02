import fs from "node:fs";
import path from "node:path";
import { stripCursorKit } from "./cursor";
import { git, gitOk, pathExists } from "./git";
import { stripIgnoreBlock } from "./ignore";
import { loadManifest } from "./manifest";
import { dropOverlayPaths } from "./overlay";
import { pathsFor, type HostPaths } from "./paths";
import { listUmbrellaWorktrees } from "./prune";
import { nestedWorkTree, resolveNestedGitDir, restoreNestedGit } from "./relocate";
import type { NestedRepo } from "./types";

export type UninstallOptions = {
  commit?: boolean;
};

function cascadeStatePath(nwt: string): string {
  return path.join(nwt, "cascade-state.json");
}

async function gitDirInFlight(opts: { cwd?: string; gitDir?: string }): Promise<boolean> {
  const merge = await gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
    ...opts,
    allowFail: true,
  });
  if (merge) return true;
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const located = await git(["rev-parse", "--git-path", name], { ...opts, allowFail: true });
    if (located.code !== 0) continue;
    const locatedPath = located.stdout.trim();
    const abs = path.isAbsolute(locatedPath)
      ? locatedPath
      : path.resolve(opts.gitDir ?? opts.cwd ?? process.cwd(), locatedPath);
    if (pathExists(abs)) return true;
  }
  return false;
}

async function assertNotInFlight(paths: HostPaths, nested: NestedRepo[]): Promise<void> {
  if (pathExists(cascadeStatePath(paths.nwt))) {
    throw new Error("cannot uninstall while a cascade merge/rebase is in progress");
  }
  if (await gitDirInFlight({ cwd: paths.root })) {
    throw new Error("cannot uninstall while the umbrella has a merge or rebase in progress");
  }
  for (const entry of nested) {
    const gitDir = await resolveNestedGitDir(paths.root, entry.gitDir);
    if (await gitDirInFlight({ gitDir })) {
      throw new Error(`cannot uninstall while ${entry.path} has a merge or rebase in progress`);
    }
  }
}

function sameWorktree(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

async function otherUmbrellaStillUsesNested(
  root: string,
  entry: NestedRepo,
): Promise<boolean> {
  const umbrellas = await listUmbrellaWorktrees(root);
  for (const wt of umbrellas) {
    if (sameWorktree(wt, root)) continue;
    const other = loadManifest(pathsFor(wt));
    if (other.nested.some((item) => item.path === entry.path || item.gitDir === entry.gitDir)) {
      return true;
    }
  }
  return false;
}

function stripGeneratedGitignore(root: string): void {
  const gitignorePath = path.join(root, ".gitignore");
  if (!fs.existsSync(gitignorePath)) return;
  const next = stripIgnoreBlock(fs.readFileSync(gitignorePath, "utf8"));
  fs.writeFileSync(gitignorePath, next);
}

async function unsetNwtHooksPath(root: string): Promise<void> {
  const current = await git(["config", "--get", "core.hooksPath"], { cwd: root, allowFail: true });
  if (current.stdout.trim() === ".nwt/hooks") {
    await git(["config", "--unset", "core.hooksPath"], { cwd: root, allowFail: true });
  }
}

function removeInheritedRules(root: string, nested: NestedRepo[]): void {
  for (const entry of nested) {
    const inherited = path.join(nestedWorkTree(root, entry.path), ".cursor", "rules", "inherited");
    if (fs.existsSync(inherited)) fs.rmSync(inherited, { recursive: true, force: true });
  }
}

function removeNwtDirKeepingSharedGit(paths: HostPaths, keepGitDirs: Set<string>): void {
  const keepResolved = new Set([...keepGitDirs].map((dir) => path.resolve(dir)));
  for (const name of ["nwt.mjs", "manifest.json", "generated.gitignore", "cascade-state.json"]) {
    const file = path.join(paths.nwt, name);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
  for (const dir of ["hooks", "bin"]) {
    const abs = path.join(paths.nwt, dir);
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
  }
  if (pathExists(paths.gitStore)) {
    for (const name of fs.readdirSync(paths.gitStore)) {
      const abs = path.join(paths.gitStore, name);
      if (keepResolved.has(path.resolve(abs))) continue;
      fs.rmSync(abs, { recursive: true, force: true });
    }
    const leftover = fs.existsSync(paths.gitStore) ? fs.readdirSync(paths.gitStore) : [];
    if (leftover.length === 0) fs.rmSync(paths.gitStore, { recursive: true, force: true });
  }
  if (fs.existsSync(paths.nwt) && fs.readdirSync(paths.nwt).length === 0) {
    fs.rmSync(paths.nwt, { recursive: true, force: true });
  }
}

async function commitUninstall(paths: HostPaths, overlayPaths: string[]): Promise<void> {
  const specs = [...new Set([".gitignore", ...overlayPaths])];
  await git(["add", "--", ".gitignore"], { cwd: paths.root, allowFail: true });
  const dirty = await git(["diff", "--cached", "--quiet", "--", ...specs], {
    cwd: paths.root,
    allowFail: true,
  });
  if (dirty.code === 0) return;
  await git(["commit", "-m", "nwt: uninstall"], { cwd: paths.root, allowFail: true });
}

export async function uninstallHost(paths: HostPaths, opts: UninstallOptions = {}): Promise<void> {
  if (!fs.existsSync(paths.manifest)) {
    throw new Error(`not an nwt host: ${paths.root}`);
  }

  stripCursorKit(paths.root);

  const manifest = loadManifest(paths);
  const nested = [...manifest.nested];
  const overlayPaths = [...manifest.overlay.paths];
  await assertNotInFlight(paths, nested);

  await dropOverlayPaths(paths, manifest);
  stripGeneratedGitignore(paths.root);

  const keepGitDirs = new Set<string>();
  for (const entry of nested) {
    const gitDir = await resolveNestedGitDir(paths.root, entry.gitDir);
    const workTree = nestedWorkTree(paths.root, entry.path);
    const shared = await otherUmbrellaStillUsesNested(paths.root, entry);
    await restoreNestedGit(workTree, gitDir, { shared });
    if (shared && pathExists(gitDir)) keepGitDirs.add(gitDir);
  }

  await unsetNwtHooksPath(paths.root);
  removeInheritedRules(paths.root, nested);

  if (opts.commit !== false) await commitUninstall(paths, overlayPaths);

  removeNwtDirKeepingSharedGit(paths, keepGitDirs);
}
