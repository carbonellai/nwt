import fs from "node:fs";
import path from "node:path";

export const SHIM_MARKER = "nwt-git-shim";
export const SKIP_SPLIT_ENV = "NWT_SKIP_COMMIT_SPLIT";
export const CASCADED_ENV = "NWT_UMBRELLA_CASCADED";

export function isNwtGitShim(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const stat = fs.lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    const real = fs.realpathSync(file);
    if (real.split(path.sep).includes(".nwt") && path.basename(real) === "git") return true;
    const head = fs.readFileSync(real, "utf8").slice(0, 400);
    return head.includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

export function findRealGit(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NWT_REAL_GIT && fs.existsSync(env.NWT_REAL_GIT)) return env.NWT_REAL_GIT;
  const parts = (env.PATH ?? "").split(path.delimiter).filter((part) => part.length > 0);
  const name = process.platform === "win32" ? "git.exe" : "git";
  for (const dir of parts) {
    const candidate = path.join(dir, name);
    if (!fs.existsSync(candidate)) continue;
    if (isNwtGitShim(candidate)) continue;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
    } catch {
      continue;
    }
    return candidate;
  }
  const fallback = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
  if (fs.existsSync(fallback) && !isNwtGitShim(fallback)) return fallback;
  return name;
}

export function skipSplit(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SKIP_SPLIT_ENV] === "1" || env[CASCADED_ENV] === "1";
}
