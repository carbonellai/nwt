import fs from "node:fs";
import path from "node:path";
import { defaultShimPath, findRealGit, isNwtGitShim, SHIM_MARKER, userShimScript } from "./shimGit";

const FORBIDDEN = new Set(["/usr/bin/git", "/bin/git", "/usr/local/bin/git"]);

export function assertSafeShimTarget(target: string, realGit: string): void {
  const resolved = path.resolve(target);
  let realTarget = resolved;
  try {
    if (fs.existsSync(resolved)) realTarget = fs.realpathSync(resolved);
  } catch {
    realTarget = resolved;
  }
  if (FORBIDDEN.has(resolved) || FORBIDDEN.has(realTarget)) {
    throw new Error(`refusing to install over ${resolved} (never replace /usr/bin/git)`);
  }
  let realReal = realGit;
  try {
    if (fs.existsSync(realGit)) realReal = fs.realpathSync(realGit);
  } catch {
    realReal = realGit;
  }
  if (path.resolve(realTarget) === path.resolve(realReal)) {
    throw new Error(`refusing to overwrite the real git binary at ${realGit}`);
  }
}

export function installUserShim(target = defaultShimPath()): string {
  const resolved = path.resolve(target);
  const realGit = findRealGit();
  assertSafeShimTarget(resolved, realGit);
  if (fs.existsSync(resolved) && !isNwtGitShim(resolved)) {
    throw new Error(
      `refusing to overwrite existing git at ${resolved} (not an nwt shim). Set NWT_SHIM_PATH or remove it.`,
    );
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, userShimScript(), { mode: 0o755 });
  fs.chmodSync(resolved, 0o755);
  return resolved;
}

export function uninstallUserShim(target = defaultShimPath()): boolean {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return false;
  if (!isNwtGitShim(resolved)) {
    throw new Error(`not an nwt git shim: ${resolved}`);
  }
  fs.rmSync(resolved);
  return true;
}

export function shimInstallHint(shimPath: string): string {
  const dir = path.dirname(shimPath);
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter);
  const firstGitDir = parts.find((part) => {
    const candidate = path.join(part, "git");
    return fs.existsSync(candidate);
  });
  const onPath = parts.includes(dir);
  const ahead =
    onPath &&
    parts.findIndex((part) => part === dir) <
      (firstGitDir ? parts.indexOf(firstGitDir) : Number.POSITIVE_INFINITY);
  const lines = [
    `nwt: installed git shim at ${shimPath}`,
    `nwt: marker ${SHIM_MARKER}; real git is ${findRealGit()}`,
  ];
  if (!ahead) {
    lines.push(
      `nwt: put ${dir} first on PATH (ahead of /usr/bin), then open a new terminal.`,
      `nwt: example: export PATH="${dir}:$PATH"`,
    );
  } else {
    lines.push("nwt: shim is already ahead of other git binaries on PATH. Open a new terminal.");
  }
  lines.push(
    "nwt: a global nwt CLI does not intercept `git status`. The git shim must be first on PATH.",
    "nwt: hardcoded /usr/bin/git and some GUIs are not intercepted.",
  );
  return lines.join("\n");
}

export function writeProjectGitShim(root: string): void {
  const bin = path.join(root, ".nwt", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "git");
  const script = `#!/bin/sh
# ${SHIM_MARKER}
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
exec node "$ROOT/.nwt/nwt.mjs" git -- "$@"
`;
  fs.writeFileSync(file, script);
  fs.chmodSync(file, 0o755);
}
