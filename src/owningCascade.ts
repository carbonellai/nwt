import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBundledCli } from "./bundledCli";
import { parseGitCommand, parseMergeFlags, parseRebaseFlags } from "./gitArgs";
import { git, gitOk, spawnRealGit } from "./git";
import { loadManifest } from "./manifest";
import { syncOverlay } from "./overlay";
import { pathsFor, type HostPaths } from "./paths";
import { CASCADED_ENV } from "./realGit";
import { nestedWorkTree, resolveNestedGitDir } from "./relocate";
import type { Manifest, NestedRepo } from "./types";

export type GitResult = { code: number; stdout: string; stderr: string };

export type SpawnOpts = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  inherit: boolean;
};

async function refreshOverlay(paths: HostPaths, manifest: Manifest, materialize = false): Promise<void> {
  await syncOverlay(paths, manifest, {
    commit: true,
    materialize,
  });
}

type CascadeState = {
  op: "merge" | "rebase";
  args: string[];
  upstream?: string;
};

function statePath(paths: HostPaths): string {
  return path.join(paths.nwt, "cascade-state.json");
}

function loadState(paths: HostPaths): CascadeState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(paths), "utf8")) as CascadeState;
  } catch {
    return null;
  }
}

function saveState(paths: HostPaths, state: CascadeState): void {
  fs.mkdirSync(paths.nwt, { recursive: true });
  fs.writeFileSync(statePath(paths), `${JSON.stringify(state, null, 2)}\n`);
}

function clearState(paths: HostPaths): void {
  try {
    fs.rmSync(statePath(paths));
  } catch {
    // ignore
  }
}

export function nestedMerging(gitDir: string): boolean {
  return fs.existsSync(path.join(gitDir, "MERGE_HEAD"));
}

export function nestedRebasing(gitDir: string): boolean {
  return (
    fs.existsSync(path.join(gitDir, "rebase-merge")) || fs.existsSync(path.join(gitDir, "rebase-apply"))
  );
}

async function eachNested(
  root: string,
  fn: (entry: NestedRepo, gitDir: string, workTree: string) => Promise<GitResult | void>,
): Promise<GitResult | null> {
  const manifest = loadManifest(pathsFor(root));
  let failed: GitResult | null = null;
  for (const entry of manifest.nested) {
    const gitDir = await resolveNestedGitDir(root, entry.gitDir);
    const workTree = nestedWorkTree(root, entry.path);
    const result = await fn(entry, gitDir, workTree);
    if (result && result.code !== 0 && !failed) failed = result;
  }
  return failed;
}

async function resolveOverlayConflicts(root: string, manifest: Manifest): Promise<void> {
  const { stdout } = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: root, allowFail: true });
  const files = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const file of files) {
    const entry = manifest.nested.find(
      (item) => file === item.path || file.startsWith(`${item.path}/`),
    );
    if (!entry) continue;
    const rel = file.slice(entry.path.length).replace(/^\//, "");
    const gitDir = await resolveNestedGitDir(root, entry.gitDir);
    const blob = await git(["show", `HEAD:${rel}`], { gitDir, allowFail: true });
    if (blob.code !== 0) continue;
    const abs = path.join(root, ...file.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, blob.stdout);
    await git(["add", "--", file], { cwd: root, allowFail: true });
  }
}

function realEnv(spawn: SpawnOpts): NodeJS.ProcessEnv {
  return { ...spawn.env, [CASCADED_ENV]: "1" };
}

export async function cascadeMerge(
  args: string[],
  commandArgs: string[],
  spawn: SpawnOpts,
): Promise<GitResult> {
  const root = spawn.cwd;
  const paths = pathsFor(root);
  const flags = parseMergeFlags(commandArgs);
  const manifest = loadManifest(paths);

  if (flags.abort || flags.quit) {
    const verb = flags.abort ? "--abort" : "--quit";
    await eachNested(root, async (_entry, gitDir, workTree) => {
      if (nestedMerging(gitDir)) await git(["merge", verb], { gitDir, workTree, allowFail: true });
    });
    const umbrellaMerging = await gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root });
    clearState(paths);
    if (!umbrellaMerging) return { code: 0, stdout: "", stderr: "" };
    return spawnRealGit(args, { cwd: root, env: realEnv(spawn), inherit: spawn.inherit });
  }

  if (flags.continue) {
    const nestedFail = await eachNested(root, async (_entry, gitDir, workTree) => {
      if (nestedMerging(gitDir)) return git(["merge", "--continue"], { gitDir, workTree, allowFail: true });
    });
    if (nestedFail) return nestedFail;
    const merging = await gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: root });
    if (merging) {
      const result = await spawnRealGit(args, { cwd: root, env: realEnv(spawn), inherit: spawn.inherit });
      if (result.code === 0) {
        await refreshOverlay(paths, loadManifest(paths), true);
        clearState(paths);
      }
      return result;
    }
    const state = loadState(paths);
    if (state?.op === "merge") {
      const { commandArgs } = parseGitCommand(state.args);
      return cascadeMerge(state.args, commandArgs, spawn);
    }
    await refreshOverlay(paths, manifest, true);
    return { code: 0, stdout: "", stderr: "" };
  }

  saveState(paths, { op: "merge", args });
  const nestedFail = await eachNested(root, async (entry, gitDir, workTree) => {
    const result = await git(["merge", ...commandArgs], { gitDir, workTree, allowFail: true });
    if (result.code !== 0 && /not something we can merge|bad revision|unknown revision/i.test(result.stderr)) {
      console.warn(`nwt: skip merge in ${entry.path}: ${result.stderr.trim()}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    return result;
  });
  if (nestedFail && nestedFail.code !== 0) return nestedFail;

  const result = await spawnRealGit(args, { cwd: root, env: realEnv(spawn), inherit: spawn.inherit });
  await resolveOverlayConflicts(root, loadManifest(paths));
  if (result.code === 0) {
    await refreshOverlay(paths, loadManifest(paths), true);
    clearState(paths);
  }
  return result;
}

async function rangeCommits(
  opts: { cwd?: string; gitDir?: string },
  range: string,
): Promise<Array<{ sha: string; subject: string }>> {
  const result = await git(["log", "--reverse", "--format=%H%x09%s", range], { ...opts, allowFail: true });
  if (result.code !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
}

async function umbrellaSubject(root: string, sha: string): Promise<string> {
  const { stdout } = await git(["log", "-1", "--format=%s", sha], { cwd: root, allowFail: true });
  return stdout.trim();
}

async function commitTouchesEntry(root: string, sha: string, entry: NestedRepo): Promise<boolean> {
  const { stdout } = await git(["diff-tree", "--no-commit-id", "-r", "--name-only", sha], {
    cwd: root,
    allowFail: true,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .some((file) => file === entry.path || file.startsWith(`${entry.path}/`));
}

function translateTodo(
  todo: string,
  subjects: Map<string, string>,
  nestedCommits: Array<{ sha: string; subject: string }>,
  touches: Map<string, boolean>,
): { text: string; mapped: boolean } {
  const unused = [...nestedCommits];
  const lines = todo.split("\n");
  const out: string[] = [];
  let mapped = true;
  let actions = 0;
  for (const line of lines) {
    const match = line.match(/^(pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([0-9a-f]+)(.*)$/i);
    if (!match) {
      out.push(line);
      continue;
    }
    const verb = match[1];
    const sha = match[2];
    const rest = match[3] ?? "";
    if (touches.get(sha) === false) continue;
    const subject = subjects.get(sha) ?? rest.trim();
    const idx = unused.findIndex((commit) => commit.subject === subject);
    if (idx === -1) {
      if (touches.get(sha)) mapped = false;
      continue;
    }
    const [nested] = unused.splice(idx, 1);
    out.push(`${verb} ${nested.sha}${rest}`);
    actions += 1;
  }
  if (actions === 0) return { text: "noop\n", mapped: true };
  return { text: `${out.join("\n")}\n`, mapped };
}

async function rebaseNestedInteractive(
  root: string,
  entry: NestedRepo,
  gitDir: string,
  workTree: string,
  todo: string,
  upstream: string,
): Promise<GitResult> {
  const nestedCommits = await rangeCommits({ gitDir }, `${upstream}..HEAD`);
  const shas = [...todo.matchAll(/^(?:pick|p|reword|r|edit|e|squash|s|fixup|f|drop|d)\s+([0-9a-f]+)/gim)].map(
    (match) => match[1],
  );
  const subjects = new Map<string, string>();
  const touches = new Map<string, boolean>();
  for (const sha of shas) {
    subjects.set(sha, await umbrellaSubject(root, sha));
    touches.set(sha, await commitTouchesEntry(root, sha, entry));
  }
  const translated = translateTodo(todo, subjects, nestedCommits, touches);
  if (!translated.mapped) {
    console.warn(`nwt: could not map interactive rebase for ${entry.path}; rebasing onto ${upstream}`);
    return git(["rebase", upstream], { gitDir, workTree, allowFail: true });
  }
  const todoPath = path.join(os.tmpdir(), `nwt-rebase-${entry.id}-${process.pid}`);
  fs.writeFileSync(todoPath, translated.text);
  const result = await git(["rebase", "--autostash", "-i", upstream], {
    gitDir,
    workTree,
    allowFail: true,
    env: { GIT_SEQUENCE_EDITOR: `cp "${todoPath}"` },
  });
  try {
    fs.rmSync(todoPath);
  } catch {
    // ignore
  }
  return result;
}

export async function handleSequenceEditor(todoFile: string): Promise<number> {
  const orig = process.env.NWT_ORIG_SEQUENCE_EDITOR;
  if (orig && orig !== "true" && orig !== ":") {
    const quoted = todoFile.replaceAll('"', '\\"');
    const spawned = spawnSync(`${orig} "${quoted}"`, { shell: true, stdio: "inherit" });
    if (spawned.status) return spawned.status;
  }
  const root = process.env.NWT_UMBRELLA_ROOT ?? "";
  if (!root || !fs.existsSync(todoFile)) return 0;
  const todo = fs.readFileSync(todoFile, "utf8");
  const upstream = process.env.NWT_REBASE_UPSTREAM || "HEAD";
  const manifest = loadManifest(pathsFor(root));
  for (const entry of manifest.nested) {
    const gitDir = await resolveNestedGitDir(root, entry.gitDir);
    const workTree = nestedWorkTree(root, entry.path);
    const result = await rebaseNestedInteractive(root, entry, gitDir, workTree, todo, upstream);
    if (result.code !== 0) {
      console.warn(`nwt: nested rebase in ${entry.path} stopped:\n${result.stderr || result.stdout}`);
      return result.code;
    }
  }
  return 0;
}

function withAutostash(args: string[]): string[] {
  if (args.includes("--autostash") || args.includes("--no-autostash")) return args;
  const idx = args.indexOf("rebase");
  if (idx === -1) return args;
  return [...args.slice(0, idx + 1), "--autostash", ...args.slice(idx + 1)];
}

function sequenceEditorCmd(root: string): string {
  const inProject = path.join(root, ".nwt", "nwt.mjs");
  const cli = fs.existsSync(inProject) ? inProject : (resolveBundledCli() ?? inProject);
  return `node "${cli}" hook-sequence-editor`;
}

export async function cascadeRebase(
  args: string[],
  commandArgs: string[],
  spawn: SpawnOpts,
): Promise<GitResult> {
  const root = spawn.cwd;
  const paths = pathsFor(root);
  const flags = parseRebaseFlags(commandArgs);
  const manifest = loadManifest(paths);

  if (flags.abort || flags.quit || flags.skip) {
    const verb = flags.abort ? "--abort" : flags.quit ? "--quit" : "--skip";
    await eachNested(root, async (_entry, gitDir, workTree) => {
      if (nestedRebasing(gitDir)) await git(["rebase", verb], { gitDir, workTree, allowFail: true });
    });
    const umbrellaRebasing =
      fs.existsSync(path.join(root, ".git", "rebase-merge")) ||
      fs.existsSync(path.join(root, ".git", "rebase-apply"));
    if (flags.abort || flags.quit) clearState(paths);
    if (!umbrellaRebasing && (flags.abort || flags.quit)) return { code: 0, stdout: "", stderr: "" };
    const result = await spawnRealGit(args, { cwd: root, env: realEnv(spawn), inherit: spawn.inherit });
    if (result.code === 0 && flags.skip) {
      await refreshOverlay(paths, loadManifest(paths), true);
      clearState(paths);
    }
    return result;
  }

  if (flags.continue) {
    const nestedFail = await eachNested(root, async (_entry, gitDir, workTree) => {
      if (nestedRebasing(gitDir)) return git(["rebase", "--continue"], { gitDir, workTree, allowFail: true });
    });
    if (nestedFail) return nestedFail;
    const rebasing =
      fs.existsSync(path.join(root, ".git", "rebase-merge")) ||
      fs.existsSync(path.join(root, ".git", "rebase-apply"));
    if (rebasing) {
      const result = await spawnRealGit(args, { cwd: root, env: realEnv(spawn), inherit: spawn.inherit });
      if (result.code === 0) {
        await refreshOverlay(paths, loadManifest(paths), true);
        clearState(paths);
      }
      return result;
    }
    const state = loadState(paths);
    if (state?.op === "rebase") {
      const { commandArgs } = parseGitCommand(state.args);
      return cascadeRebase(state.args, commandArgs, spawn);
    }
    await refreshOverlay(paths, manifest, true);
    return { code: 0, stdout: "", stderr: "" };
  }

  saveState(paths, { op: "rebase", args, upstream: flags.upstream ?? undefined });
  await refreshOverlay(paths, manifest, true);
  const overlayPaths = loadManifest(paths).overlay.paths;
  if (overlayPaths.length > 0) {
    await git(["checkout", "-f", "HEAD", "--", ...overlayPaths], { cwd: root, allowFail: true });
  }

  if (flags.interactive) {
    await git(["stash", "push", "-u", "-m", "nwt-pre-rebase"], { cwd: root, allowFail: true });
    const env: NodeJS.ProcessEnv = {
      ...spawn.env,
      [CASCADED_ENV]: "1",
      NWT_ORIG_SEQUENCE_EDITOR: spawn.env.GIT_SEQUENCE_EDITOR ?? spawn.env.GIT_EDITOR ?? "true",
      GIT_SEQUENCE_EDITOR: sequenceEditorCmd(root),
      NWT_UMBRELLA_ROOT: root,
      NWT_REBASE_UPSTREAM: flags.upstream ?? flags.onto ?? "",
    };
    const result = await spawnRealGit(withAutostash(args), { cwd: root, env, inherit: spawn.inherit });
    await git(["stash", "pop"], { cwd: root, allowFail: true });
    if (result.code === 0) {
      await refreshOverlay(paths, loadManifest(paths), true);
      clearState(paths);
    }
    return result;
  }

  const nestedFail = await eachNested(root, async (entry, gitDir, workTree) => {
    const result = await git(["rebase", ...commandArgs], { gitDir, workTree, allowFail: true });
    if (result.code !== 0 && /does not exist|unknown revision|fatal: Needed a single revision/i.test(result.stderr)) {
      console.warn(`nwt: skip rebase in ${entry.path}: ${result.stderr.trim()}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    return result;
  });
  if (nestedFail && nestedFail.code !== 0) return nestedFail;

  await refreshOverlay(paths, loadManifest(paths), true);
  const result = await spawnRealGit(withAutostash(args), { cwd: root, env: realEnv(spawn), inherit: spawn.inherit });
  if (result.code === 0) {
    await refreshOverlay(paths, loadManifest(paths), true);
    clearState(paths);
  }
  return result;
}

export async function handlePreRebase(root: string, upstream: string): Promise<number> {
  if (process.env[CASCADED_ENV] === "1") return 0;
  const paths = pathsFor(root);
  const failed = await eachNested(root, async (entry, gitDir, workTree) => {
    const result = await git(["rebase", upstream], { gitDir, workTree, allowFail: true });
    if (result.code !== 0 && /does not exist|unknown revision/i.test(result.stderr)) {
      console.warn(`nwt: skip rebase in ${entry.path}: ${result.stderr.trim()}`);
      return { code: 0, stdout: "", stderr: "" };
    }
    return result;
  });
  return failed?.code ?? 0;
}

export async function mergeNestedFromMessage(root: string): Promise<void> {
  const { stdout } = await git(["log", "-1", "--format=%s"], { cwd: root, allowFail: true });
  const match = stdout.match(/Merge (?:branch|tag) '([^']+)'/);
  if (!match) return;
  const name = match[1];
  await eachNested(root, async (entry, gitDir, workTree) => {
    if (await gitOk(["rev-parse", "--verify", "-q", name], { gitDir })) {
      const result = await git(["merge", "--no-edit", name], { gitDir, workTree, allowFail: true });
      if (result.code !== 0) {
        console.warn(`nwt: post-merge in ${entry.path}: ${result.stderr.trim()}`);
      }
    }
  });
}
