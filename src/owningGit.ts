import { parseCommitFlags, parseGitCommand } from "./gitArgs";
import { git, gitOk, gitRaw, spawnRealGit } from "./git";
import { loadManifest } from "./manifest";
import {
  cascadeMerge,
  cascadeRebase,
  handleSequenceEditor,
  type SpawnOpts,
  type GitResult,
} from "./owningCascade";
import { syncOverlay } from "./overlay";
import { pathsFor, type HostPaths } from "./paths";
import { CASCADED_ENV, skipSplit } from "./realGit";
import { nestedWorkTree, resolveNestedGitDir } from "./relocate";
import { pruneMissingNested } from "./prune";
import { findUmbrellaRoot, resolveNestedFromPath } from "./resolve";
import type { Manifest, NestedRepo } from "./types";

export type PathChange = { status: string; path: string; orig?: string };

export function nestedForRel(manifest: Manifest, rel: string): NestedRepo | null {
  const normalized = rel.replaceAll("\\", "/");
  let best: NestedRepo | null = null;
  for (const entry of manifest.nested) {
    if (normalized === entry.path || normalized.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best;
}

function stripPrefix(prefix: string, rel: string): string | null {
  if (rel === prefix) return "";
  if (rel.startsWith(`${prefix}/`)) return rel.slice(prefix.length + 1);
  return null;
}

export function parseNameStatus(stdout: string): PathChange[] {
  const parts = stdout.split("\0").filter((part) => part.length > 0);
  const out: PathChange[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const orig = parts[i++];
      const dest = parts[i++];
      if (orig && dest) out.push({ status: status[0], path: dest, orig });
    } else {
      const file = parts[i++];
      if (file) out.push({ status: status[0], path: file });
    }
  }
  return out;
}

export async function cachedChanges(root: string): Promise<PathChange[]> {
  const { stdout } = await git(["diff", "--cached", "-z", "--name-status"], { cwd: root, allowFail: true });
  return parseNameStatus(stdout);
}

export async function headChanges(root: string): Promise<PathChange[]> {
  const { stdout } = await git(["diff-tree", "--no-commit-id", "-r", "-z", "--name-status", "--root", "HEAD"], {
    cwd: root,
    allowFail: true,
  });
  return parseNameStatus(stdout);
}

async function blobMode(
  root: string,
  overlayPath: string,
  source: "index" | "HEAD",
): Promise<string> {
  if (source === "index") {
    const { stdout } = await git(["ls-files", "--stage", "--", overlayPath], { cwd: root, allowFail: true });
    const match = stdout.match(/^(\d+)/);
    return match?.[1] ?? "100644";
  }
  const { stdout } = await git(["ls-tree", "HEAD", "--", overlayPath], { cwd: root, allowFail: true });
  const match = stdout.match(/^(\d+) blob /);
  return match?.[1] ?? "100644";
}

export async function applyChangesToNested(
  root: string,
  entry: NestedRepo,
  changes: PathChange[],
  source: "index" | "HEAD",
): Promise<boolean> {
  const gitDir = await resolveNestedGitDir(root, entry.gitDir);
  const workTree = nestedWorkTree(root, entry.path);
  let changed = false;
  for (const change of changes) {
    const nestedPath = stripPrefix(entry.path, change.path);
    if (nestedPath === null) continue;
    if (change.status === "D") {
      await git(["rm", "--cached", "-f", "--ignore-unmatch", "--", nestedPath], {
        gitDir,
        workTree,
        allowFail: true,
      });
      changed = true;
      continue;
    }
    if (change.orig) {
      const oldPath = stripPrefix(entry.path, change.orig);
      if (oldPath) {
        await git(["rm", "--cached", "-f", "--ignore-unmatch", "--", oldPath], {
          gitDir,
          workTree,
          allowFail: true,
        });
      }
    }
    const spec = source === "index" ? `:${change.path}` : `HEAD:${change.path}`;
    const blob = await gitRaw(["cat-file", "blob", spec], { cwd: root, allowFail: true });
    if (blob.code !== 0) continue;
    const hashed = await gitRaw(["hash-object", "-w", "--stdin"], { gitDir, stdin: blob.stdout });
    const sha = hashed.stdout.toString("utf8").trim();
    const mode = await blobMode(root, change.path, source);
    await git(["update-index", "--add", "--cacheinfo", `${mode},${sha},${nestedPath}`], {
      gitDir,
      workTree,
    });
    changed = true;
  }
  return changed;
}

async function logField(opts: { cwd?: string; gitDir?: string }, format: string, rev = "HEAD"): Promise<string> {
  const result = await git(["log", "-1", `--format=${format}`, rev], { ...opts, allowFail: true });
  return result.stdout.trim();
}

async function shouldAmendNested(root: string, gitDir: string): Promise<boolean> {
  const umbrellaSubject = await logField({ cwd: root }, "%s");
  const nestedSubject = await logField({ gitDir }, "%s");
  if (umbrellaSubject.startsWith("nwt:")) return true;
  return Boolean(umbrellaSubject && nestedSubject && umbrellaSubject === nestedSubject);
}

async function commitNested(
  root: string,
  entry: NestedRepo,
  opts: { message: string | null; amend: boolean; noEdit: boolean },
): Promise<GitResult | null> {
  const gitDir = await resolveNestedGitDir(root, entry.gitDir);
  const workTree = nestedWorkTree(root, entry.path);
  const indexDirty = !(await gitOk(["diff", "--cached", "--quiet"], { gitDir, workTree }));
  const amend = opts.amend && (await shouldAmendNested(root, gitDir));
  if (!indexDirty && !amend) return null;
  if (!indexDirty && amend && !opts.message && opts.noEdit) return null;
  const args = ["commit", "--no-verify"];
  if (amend) args.push("--amend");
  if (opts.message) args.push("-m", opts.message);
  else if (amend || opts.noEdit) args.push("--no-edit");
  else return null;
  if (!indexDirty) args.push("--allow-empty");
  const result = await git(args, { gitDir, workTree, allowFail: true });
  return result;
}

function groupByNested(manifest: Manifest, changes: PathChange[]): Map<NestedRepo, PathChange[]> {
  const grouped = new Map<NestedRepo, PathChange[]>();
  for (const change of changes) {
    const entry = nestedForRel(manifest, change.path);
    if (!entry) continue;
    const list = grouped.get(entry) ?? [];
    list.push(change);
    grouped.set(entry, list);
  }
  return grouped;
}

async function unstageOverlay(root: string, changes: PathChange[], manifest: Manifest): Promise<void> {
  const paths = changes.filter((change) => nestedForRel(manifest, change.path)).map((change) => change.path);
  if (paths.length === 0) return;
  await git(["restore", "--staged", "--", ...paths], { cwd: root, allowFail: true });
}

export async function refreshOverlay(paths: HostPaths, manifest: Manifest, materialize = false): Promise<void> {
  await syncOverlay(paths, manifest, {
    commit: true,
    materialize,
  });
}

export async function splitCommit(
  root: string,
  opts: {
    message: string | null;
    amend: boolean;
    noEdit: boolean;
    source?: "index" | "HEAD";
  },
): Promise<{ nested: number; leftover: boolean }> {
  const paths = pathsFor(root);
  const manifest = loadManifest(paths);
  const source = opts.source ?? "index";
  const changes = source === "index" ? await cachedChanges(root) : await headChanges(root);
  const grouped = groupByNested(manifest, changes);
  let nested = 0;
  for (const [entry, files] of grouped) {
    const applied = await applyChangesToNested(root, entry, files, source);
    if (!applied && !opts.amend) continue;
    const committed = await commitNested(root, entry, opts);
    if (committed && committed.code === 0) nested += 1;
    else if (committed && committed.code !== 0) {
      console.warn(`nwt: nested commit failed in ${entry.path}: ${committed.stderr.trim()}`);
    }
  }
  if (source === "index") await unstageOverlay(root, changes, manifest);
  const leftover = !(await gitOk(["diff", "--cached", "--quiet"], { cwd: root }));
  return { nested, leftover };
}

async function messageFromHead(root: string): Promise<string> {
  return logField({ cwd: root }, "%B");
}

export async function handlePostCommit(root: string): Promise<void> {
  await pruneMissingNested(pathsFor(root), { commit: true });
  if (skipSplit()) return;
  const subject = await logField({ cwd: root }, "%s");
  if (subject.startsWith("nwt:")) {
    return;
  }
  const message = await messageFromHead(root);
  await splitCommit(root, { message, amend: false, noEdit: true, source: "HEAD" });
  const paths = pathsFor(root);
  await refreshOverlay(paths, loadManifest(paths));
}

export async function handlePostRewrite(root: string, kind: string): Promise<void> {
  if (skipSplit()) return;
  if (kind === "amend") {
    const message = await messageFromHead(root);
    await splitCommit(root, { message, amend: true, noEdit: true, source: "HEAD" });
  }
  const paths = pathsFor(root);
  await refreshOverlay(paths, loadManifest(paths), true);
}

export async function handlePostMerge(root: string): Promise<void> {
  await pruneMissingNested(pathsFor(root), { commit: true });
  if (skipSplit()) return;
  const paths = pathsFor(root);
  await refreshOverlay(paths, loadManifest(paths), true);
}

async function handleCommit(args: string[], commandArgs: string[], spawn: SpawnOpts): Promise<GitResult> {
  const flags = parseCommitFlags(commandArgs);
  if (flags.all) {
    await git(["add", "-u"], { cwd: spawn.cwd, allowFail: true });
  }
  let message = flags.message;
  if (!message && flags.amend && flags.noEdit) {
    message = await messageFromHead(spawn.cwd);
  }
  if (!message && !flags.amend) {
    const env = { ...spawn.env, [CASCADED_ENV]: "1" };
    const result = await spawnRealGit(args, { cwd: spawn.cwd, env, inherit: spawn.inherit });
    if (result.code === 0) await handlePostCommit(spawn.cwd);
    return result;
  }
  if (!message && flags.amend) {
    const env = { ...spawn.env, [CASCADED_ENV]: "1" };
    const result = await spawnRealGit(args, { cwd: spawn.cwd, env, inherit: spawn.inherit });
    if (result.code === 0) await handlePostRewrite(spawn.cwd, "amend");
    return result;
  }
  const split = await splitCommit(spawn.cwd, {
    message,
    amend: flags.amend,
    noEdit: flags.noEdit,
  });
  const paths = pathsFor(spawn.cwd);
  const manifest = loadManifest(paths);
  if (!split.leftover && !flags.allowEmpty) {
    await refreshOverlay(paths, manifest);
    return { code: 0, stdout: "", stderr: "" };
  }
  const env = { ...spawn.env, [CASCADED_ENV]: "1" };
  const result = await spawnRealGit(args, { cwd: spawn.cwd, env, inherit: spawn.inherit });
  if (result.code === 0) {
    await syncOverlay(paths, loadManifest(paths), {
      commit: false,
    });
    const dirty = !(await gitOk(["diff", "--cached", "--quiet"], { cwd: spawn.cwd }));
    if (dirty) {
      await git(["commit", "--amend", "--no-edit", "--no-verify"], { cwd: spawn.cwd, allowFail: true });
    }
  }
  return result;
}

export async function interceptUmbrellaGit(args: string[], spawn: SpawnOpts): Promise<GitResult | null> {
  if (skipSplit(spawn.env) || spawn.env.GIT_DIR) return null;
  const root = findUmbrellaRoot(spawn.cwd);
  if (!root) return null;
  await pruneMissingNested(pathsFor(root), { commit: true });
  if (resolveNestedFromPath(spawn.cwd)) return null;
  const { command, commandArgs } = parseGitCommand(args);
  if (!command) return null;
  const cwdSpawn = { ...spawn, cwd: root };
  if (command === "commit") return handleCommit(args, commandArgs, cwdSpawn);
  if (command === "merge") return cascadeMerge(args, commandArgs, cwdSpawn);
  if (command === "rebase") return cascadeRebase(args, commandArgs, cwdSpawn);
  return null;
}

export async function runSequenceEditor(todoFile: string): Promise<number> {
  return handleSequenceEditor(todoFile);
}
