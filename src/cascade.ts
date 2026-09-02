import fs from "node:fs";
import path from "node:path";
import { currentBranch, git, gitOk } from "./git";
import { loadManifest } from "./manifest";
import { syncOverlay } from "./overlay";
import type { HostPaths } from "./paths";
import { pathsFor } from "./paths";
import { hideGitPointer, nestedGitDir, nestedWorkTree } from "./relocate";
import { withSkipPrune } from "./prune";
import { applyRules } from "./rules";
import type { NestedRepo } from "./types";

async function branchExists(gitDir: string, name: string): Promise<boolean> {
  return gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], { gitDir });
}

async function branchCheckedOut(gitDir: string, name: string): Promise<boolean> {
  const result = await git(["worktree", "list", "--porcelain"], { gitDir, allowFail: true });
  if (result.code !== 0) return false;
  return result.stdout.includes(`branch refs/heads/${name}`);
}

export async function createBranchEverywhere(
  paths: HostPaths,
  name: string,
  opts: { fromNested?: boolean } = {},
): Promise<void> {
  const manifest = loadManifest(paths);
  if (!opts.fromNested) {
    const exists = await gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
      cwd: paths.root,
    });
    if (!exists) await git(["branch", name], { cwd: paths.root });
  }
  for (const entry of manifest.nested) {
    const gitDir = nestedGitDir(paths.root, entry.gitDir);
    if (await branchExists(gitDir, name)) continue;
    const result = await git(["branch", name], { gitDir, workTree: nestedWorkTree(paths.root, entry.path), allowFail: true });
    if (result.code !== 0) {
      console.warn(`nwt: skip branch ${name} in ${entry.path}: ${result.stderr.trim()}`);
    }
  }
}

async function addNestedWorktree(
  paths: HostPaths,
  entry: NestedRepo,
  rootWorktree: string,
  branch: string,
): Promise<void> {
  await withSkipPrune(async () => {
    const gitDir = nestedGitDir(paths.root, entry.gitDir);
    const dest = path.join(rootWorktree, ...entry.path.split("/"));
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    if (await branchCheckedOut(gitDir, branch) && !(await branchExists(gitDir, branch))) {
      // fall through to create
    }
    const args = ["worktree", "add"];
    if (await branchExists(gitDir, branch)) {
      if (await branchCheckedOut(gitDir, branch)) {
        console.warn(`nwt: skip ${entry.path}: branch ${branch} already checked out`);
        return;
      }
      args.push(dest, branch);
    } else {
      args.push("-b", branch, dest);
    }
    const result = await git(args, { gitDir, allowFail: true });
    if (result.code !== 0) {
      console.warn(`nwt: worktree add failed for ${entry.path}: ${result.stderr.trim()}`);
      return;
    }
    const { stdout } = await git(["rev-parse", "--git-dir"], {
      gitDir,
      workTree: dest,
      allowFail: true,
    });
    const linked = stdout.trim() || gitDir;
    await hideGitPointer(dest, path.isAbsolute(linked) ? linked : path.resolve(dest, linked));
  });
}

export async function worktreeAdd(
  paths: HostPaths,
  worktreePath: string,
  branch?: string,
  opts: { skipRoot?: boolean } = {},
): Promise<void> {
  await withSkipPrune(async () => {
    const abs = path.resolve(paths.root, worktreePath);
    const name = branch ?? path.basename(abs);
    if (!opts.skipRoot) {
      const exists = await gitOk(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
        cwd: paths.root,
      });
      const args = exists
        ? ["worktree", "add", abs, name]
        : ["worktree", "add", "-b", name, abs];
      await git(args, { cwd: paths.root });
    }
    const manifest = loadManifest(paths);
    for (const entry of manifest.nested) {
      await addNestedWorktree(paths, entry, abs, name);
    }
    const newPaths = pathsFor(abs);
    await applyRules(newPaths, manifest);
    await syncOverlay(newPaths, manifest, { commit: false, nestedRoot: paths.root });
  });
}

export async function worktreeRemove(paths: HostPaths, worktreePath: string): Promise<void> {
  const abs = path.resolve(paths.root, worktreePath);
  const manifest = loadManifest(paths);
  for (const entry of [...manifest.nested].reverse()) {
    const dest = path.join(abs, ...entry.path.split("/"));
    const gitDir = nestedGitDir(paths.root, entry.gitDir);
    await git(["worktree", "remove", "--force", dest], { gitDir, allowFail: true });
  }
  await git(["worktree", "remove", "--force", abs], { cwd: paths.root });
}

export async function worktreeList(paths: HostPaths): Promise<string> {
  const { stdout } = await git(["worktree", "list"], { cwd: paths.root });
  return stdout;
}

export async function setupWorktree(paths: HostPaths, env = process.env): Promise<void> {
  await withSkipPrune(async () => {
    const mainRoot = env.ROOT_WORKTREE_PATH || paths.root;
    const newRoot = process.cwd();
    const mainPaths = pathsFor(mainRoot);
    const manifest = loadManifest(mainPaths);
    const branch = await currentBranch(newRoot);
    for (const entry of manifest.nested) {
      await addNestedWorktree(mainPaths, entry, newRoot, branch);
    }
    const newPaths = pathsFor(newRoot);
    await applyRules(newPaths, manifest);
    await syncOverlay(newPaths, manifest, {
      commit: true,
      nestedRoot: mainRoot,
    });
  });
}
