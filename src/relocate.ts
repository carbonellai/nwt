import fs from "node:fs";
import path from "node:path";
import { git } from "./git";
import { absFromRel, pathExists } from "./git";
import { gitDirRel } from "./manifest";

function readGitfile(gitPath: string, workTree: string): string {
  const text = fs.readFileSync(gitPath, "utf8");
  const match = text.match(/gitdir:\s*(.+)/i);
  if (!match) throw new Error(`invalid gitfile at ${gitPath}`);
  const loc = match[1].trim();
  return path.isAbsolute(loc) ? loc : path.resolve(workTree, loc);
}

export async function hideGitPointer(workTree: string, gitDir: string): Promise<void> {
  const pointer = path.join(workTree, ".git");
  if (pathExists(pointer)) fs.rmSync(pointer, { recursive: true, force: true });
  await git(["config", "core.bare", "false"], { gitDir });
  await git(["config", "core.worktree", path.resolve(workTree)], { gitDir });
}

export async function relocateRepo(
  root: string,
  relPath: string,
  id: string,
): Promise<string> {
  const workTree = absFromRel(root, relPath);
  const destRel = gitDirRel(id);
  const dest = absFromRel(root, destRel);
  const gitPath = path.join(workTree, ".git");

  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (!pathExists(gitPath)) {
    if (!pathExists(dest)) {
      throw new Error(`No git directory found for ${relPath}`);
    }
    await hideGitPointer(workTree, dest);
    return destRel;
  }

  const stat = fs.lstatSync(gitPath);
  if (stat.isFile()) {
    const real = readGitfile(gitPath, workTree);
    fs.rmSync(gitPath);
    if (path.resolve(real) !== path.resolve(dest)) {
      if (!pathExists(dest)) fs.cpSync(real, dest, { recursive: true });
    }
  } else if (pathExists(dest)) {
    fs.rmSync(gitPath, { recursive: true, force: true });
  } else {
    fs.renameSync(gitPath, dest);
  }

  await hideGitPointer(workTree, dest);
  return destRel;
}

export function nestedGitDir(root: string, gitDirRelPath: string): string {
  return absFromRel(root, gitDirRelPath);
}

export async function resolveNestedGitDir(root: string, gitDirRelPath: string): Promise<string> {
  const local = nestedGitDir(root, gitDirRelPath);
  if (pathExists(local)) return local;
  const fromEnv = process.env.ROOT_WORKTREE_PATH;
  if (fromEnv) {
    const shared = nestedGitDir(fromEnv, gitDirRelPath);
    if (pathExists(shared)) return shared;
  }
  const listed = await git(["worktree", "list", "--porcelain"], { cwd: root, allowFail: true });
  if (listed.code === 0) {
    for (const line of listed.stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const wt = line.slice("worktree ".length).trim();
      const abs = nestedGitDir(wt, gitDirRelPath);
      if (pathExists(abs)) return abs;
    }
  }
  return local;
}

export function nestedWorkTree(root: string, relPath: string): string {
  return absFromRel(root, relPath);
}
