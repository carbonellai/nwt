import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { interceptUmbrellaGit } from "./owningGit";
import { pathsFor } from "./paths";
import { pruneMissingNested } from "./prune";
import { findRealGit, isNwtGitShim, SHIM_MARKER } from "./realGit";
import { nestedWorkTree, resolveNestedGitDir } from "./relocate";
import { findUmbrellaRoot, resolveNestedFromPath } from "./resolve";

export { findRealGit, isNwtGitShim, SHIM_MARKER };

export function parseGitShimArgs(args: string[]): {
  hasGitDir: boolean;
  cDirs: string[];
} {
  let hasGitDir = false;
  const cDirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "--git-dir" || arg.startsWith("--git-dir=")) hasGitDir = true;
    if (arg === "-C" && args[i + 1]) {
      cDirs.push(args[i + 1]);
      i += 1;
    }
  }
  return { hasGitDir, cDirs };
}

export function applyGitC(cwd: string, cDirs: string[]): string {
  let dir = cwd;
  for (const next of cDirs) dir = path.resolve(dir, next);
  return dir;
}

export function stripGitC(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-C") {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

export async function runShimGit(
  args: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    inherit?: boolean;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const inherit = opts.inherit ?? true;
  const real = findRealGit(env);

  if (env.GIT_DIR) {
    return spawnGit(real, args, { cwd, env, inherit });
  }

  const parsed = parseGitShimArgs(args);
  if (parsed.hasGitDir) {
    return spawnGit(real, args, { cwd, env, inherit });
  }

  const workStart = applyGitC(cwd, parsed.cDirs);
  const umbrella = findUmbrellaRoot(workStart) ?? findUmbrellaRoot(cwd);
  if (umbrella) {
    await pruneMissingNested(pathsFor(umbrella), { commit: true });
  }
  const nested = resolveNestedFromPath(workStart);
  if (!nested) {
    const intercepted = await interceptUmbrellaGit(stripGitC(args), { cwd: workStart, env, inherit });
    if (intercepted) return intercepted;
    return spawnGit(real, args, { cwd, env, inherit });
  }

  const gitDir = await resolveNestedGitDir(nested.root, nested.entry.gitDir);
  const workTree = nestedWorkTree(nested.root, nested.entry.path);
  const forwarded = stripGitC(args);
  return spawnGit(real, [`--git-dir=${gitDir}`, `--work-tree=${workTree}`, ...forwarded], {
    cwd: workStart,
    env,
    inherit,
  });
}

function spawnGit(
  real: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; inherit: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(real, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!opts.inherit) {
      child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    }
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function defaultShimPath(): string {
  if (process.env.NWT_SHIM_PATH) return path.resolve(process.env.NWT_SHIM_PATH);
  return path.join(os.homedir(), ".local", "bin", "git");
}

export function userShimScript(): string {
  return `#!/bin/sh
# ${SHIM_MARKER}
set -e
find_real_git() {
  if [ -n "$NWT_REAL_GIT" ] && [ -x "$NWT_REAL_GIT" ]; then
    printf '%s\\n' "$NWT_REAL_GIT"
    return
  fi
  self="$0"
  if command -v realpath >/dev/null 2>&1; then
    self=$(realpath "$0")
  fi
  IFS=:
  for dir in $PATH; do
    cand="$dir/git"
    [ -x "$cand" ] || continue
    cand_real="$cand"
    if command -v realpath >/dev/null 2>&1; then
      cand_real=$(realpath "$cand")
    fi
    [ "$cand_real" = "$self" ] && continue
    printf '%s\\n' "$cand"
    return
  done
  if [ -x /usr/bin/git ]; then
    printf '%s\\n' /usr/bin/git
    return
  fi
  printf '%s\\n' git
}

if [ -n "$GIT_DIR" ]; then
  exec "$(find_real_git)" "$@"
fi

for arg in "$@"; do
  [ "$arg" = "--" ] && break
  case "$arg" in
    --git-dir|--git-dir=*)
      exec "$(find_real_git)" "$@"
      ;;
  esac
done

start=$(pwd)
prev=""
for arg in "$@"; do
  [ "$arg" = "--" ] && break
  if [ "$prev" = "-C" ]; then
    case "$arg" in
      /*) start="$arg" ;;
      *) start="$start/$arg" ;;
    esac
    prev=""
    continue
  fi
  prev="$arg"
done
case "$start" in
  /*) ;;
  *) start="$(pwd)/$start" ;;
esac

dir="$start"
[ -d "$dir" ] || dir=$(dirname "$dir")
while [ "$dir" != "/" ]; do
  if [ -f "$dir/.nwt/nwt.mjs" ]; then
    exec node "$dir/.nwt/nwt.mjs" git -- "$@"
  fi
  next=$(dirname "$dir")
  [ "$next" = "$dir" ] && break
  dir="$next"
done

exec "$(find_real_git)" "$@"
`;
}
