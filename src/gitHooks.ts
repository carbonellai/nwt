import fs from "node:fs";
import path from "node:path";
import { resolveBundledCli } from "./bundledCli";
import { git } from "./git";

const HOOK_NAMES = ["post-commit", "post-merge", "post-rewrite", "pre-rebase"] as const;

function hookScript(command: string): string {
  return `#!/bin/sh
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
if [ -f "$ROOT/.nwt/nwt.mjs" ]; then
  exec node "$ROOT/.nwt/nwt.mjs" ${command} "$@"
fi
exit 0
`;
}

const HOOK_COMMAND: Record<(typeof HOOK_NAMES)[number], string> = {
  "post-commit": "hook-post-commit",
  "post-merge": "hook-post-merge",
  "post-rewrite": "hook-post-rewrite",
  "pre-rebase": "hook-pre-rebase",
};

export function copyBundledCli(root: string): void {
  const source = resolveBundledCli();
  if (!source) return;
  const dest = path.join(root, ".nwt", "nwt.mjs");
  if (path.resolve(source) === path.resolve(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  try {
    fs.chmodSync(dest, 0o755);
  } catch {
    // ignore
  }
}

export async function writeNwtGitHooks(root: string): Promise<void> {
  copyBundledCli(root);
  const dir = path.join(root, ".nwt", "hooks");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, hookScript(HOOK_COMMAND[name]));
    fs.chmodSync(file, 0o755);
  }
  const current = await git(["config", "--get", "core.hooksPath"], { cwd: root, allowFail: true });
  const hooksPath = current.stdout.trim();
  if (!hooksPath) {
    await git(["config", "core.hooksPath", ".nwt/hooks"], { cwd: root, allowFail: true });
  }
}
