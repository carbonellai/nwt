import fs from "node:fs";
import path from "node:path";

export const SETUP_WORKTREE_SH = `#!/bin/sh
set -e
if [ -z "$ROOT_WORKTREE_PATH" ]; then
  echo "nwt: ROOT_WORKTREE_PATH is not set" >&2
  exit 1
fi
exec node "$ROOT_WORKTREE_PATH/.nwt/nwt.mjs" setup-worktree
`;

export const AFTER_SHELL_SH = `#!/bin/sh
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -f "$ROOT/.nwt/nwt.mjs" ]; then
  exec node "$ROOT/.nwt/nwt.mjs" hook-after-shell
fi
exit 0
`;

export const DEFAULT_WORKTREES_JSON = {
  "setup-worktree-unix": [String.raw`node "$ROOT_WORKTREE_PATH/.nwt/nwt.mjs" setup-worktree`],
  "setup-worktree": [String.raw`node "$ROOT_WORKTREE_PATH/.nwt/nwt.mjs" setup-worktree`],
};

export const SESSION_START_SH = `#!/bin/sh
set -e
ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
if [ -f "$ROOT/.nwt/nwt.mjs" ]; then
  exec node "$ROOT/.nwt/nwt.mjs" hook-session-start
fi
echo '{}'
`;

export const DEFAULT_HOOKS_JSON = {
  version: 1,
  hooks: {
    afterShellExecution: [
      {
        command: ".cursor/scripts/nwt-after-shell.sh",
      },
    ],
    sessionStart: [
      {
        command: ".cursor/scripts/nwt-session-start.sh",
      },
    ],
  },
};

export const GIT_SCAN_SETTINGS = {
  "git.autoRepositoryDetection": false,
  "git.repositoryScanMaxDepth": 0,
  "terminal.integrated.env.osx": {
    PATH: "${workspaceFolder}/.nwt/bin:${env:PATH}",
  },
  "terminal.integrated.env.linux": {
    PATH: "${workspaceFolder}/.nwt/bin:${env:PATH}",
  },
  "terminal.integrated.env.windows": {
    PATH: "${workspaceFolder}\\.nwt\\bin;${env:PATH}",
  },
};

const STALE_HOOK_COMMANDS = new Set([
  ".cursor/nwt-after-shell.sh",
  ".cursor/nwt-session-start.sh",
]);

const SCRIPT_NAMES = ["nwt-setup-worktree.sh", "nwt-after-shell.sh", "nwt-session-start.sh"] as const;

export function mergeJsonFile(file: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let current: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      current = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }
  const merged = deepMerge(current, patch);
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (Array.isArray(value) && Array.isArray(existing)) {
      const seen = new Set(existing.map((item) => JSON.stringify(item)));
      out[key] = [...existing, ...value.filter((item) => !seen.has(JSON.stringify(item)))];
    } else if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripStaleHookCommands(file: string): void {
  if (!fs.existsSync(file)) return;
  let current: { hooks?: Record<string, unknown> };
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> };
  } catch {
    return;
  }
  if (!current.hooks) return;
  for (const key of Object.keys(current.hooks)) {
    const entries = current.hooks[key];
    if (!Array.isArray(entries)) continue;
    current.hooks[key] = entries.filter((item) => {
      if (!item || typeof item !== "object") return true;
      const command = (item as { command?: string }).command;
      return !command || !STALE_HOOK_COMMANDS.has(command);
    });
  }
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}

export function writeCursorKit(root: string): void {
  const cursorDir = path.join(root, ".cursor");
  const scriptsDir = path.join(cursorDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "nwt-setup-worktree.sh"), SETUP_WORKTREE_SH);
  fs.writeFileSync(path.join(scriptsDir, "nwt-after-shell.sh"), AFTER_SHELL_SH);
  fs.writeFileSync(path.join(scriptsDir, "nwt-session-start.sh"), SESSION_START_SH);
  for (const name of SCRIPT_NAMES) {
    fs.chmodSync(path.join(scriptsDir, name), 0o755);
    const stale = path.join(cursorDir, name);
    if (fs.existsSync(stale)) fs.rmSync(stale);
  }
  mergeJsonFile(path.join(cursorDir, "worktrees.json"), DEFAULT_WORKTREES_JSON);
  const hooksFile = path.join(cursorDir, "hooks.json");
  mergeJsonFile(hooksFile, DEFAULT_HOOKS_JSON);
  stripStaleHookCommands(hooksFile);
  mergeJsonFile(path.join(root, ".vscode", "settings.json"), GIT_SCAN_SETTINGS);
}
