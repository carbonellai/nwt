import fs from "node:fs";

const GLOBAL_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--list-cmds",
  "--attr-source",
]);

export function parseGitCommand(args: string[]): {
  command: string | null;
  commandArgs: string[];
} {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=") ||
      arg.startsWith("--exec-path=") ||
      arg.startsWith("--config-env=")
    ) {
      i += 1;
      continue;
    }
    if (GLOBAL_VALUE.has(arg)) {
      i += 2;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  const command = args[i] ?? null;
  return { command, commandArgs: command ? args.slice(i + 1) : [] };
}

export type CommitFlags = {
  amend: boolean;
  noEdit: boolean;
  all: boolean;
  allowEmpty: boolean;
  noVerify: boolean;
  message: string | null;
};

export function parseCommitFlags(commandArgs: string[]): CommitFlags {
  let amend = false;
  let noEdit = false;
  let all = false;
  let allowEmpty = false;
  let noVerify = false;
  const messages: string[] = [];
  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg === "--") break;
    if (arg === "--amend") amend = true;
    else if (arg === "--no-edit") noEdit = true;
    else if (arg === "-a" || arg === "--all") all = true;
    else if (arg === "--allow-empty") allowEmpty = true;
    else if (arg === "-n" || arg === "--no-verify") noVerify = true;
    else if (arg === "-m" || arg === "--message") {
      if (commandArgs[i + 1]) {
        messages.push(commandArgs[i + 1]);
        i += 1;
      }
    } else if (arg.startsWith("--message=")) messages.push(arg.slice("--message=".length));
    else if (arg === "-F" || arg === "--file") {
      const file = commandArgs[i + 1];
      if (file && file !== "-") {
        try {
          messages.push(fs.readFileSync(file, "utf8"));
        } catch {
          // ignore missing -F
        }
        i += 1;
      }
    } else if (arg.startsWith("--file=") && arg !== "--file=-") {
      try {
        messages.push(fs.readFileSync(arg.slice("--file=".length), "utf8"));
      } catch {
        // ignore
      }
    }
  }
  return {
    amend,
    noEdit,
    all,
    allowEmpty,
    noVerify,
    message: messages.length > 0 ? messages.join("\n\n") : null,
  };
}

export type MergeFlags = {
  abort: boolean;
  continue: boolean;
  quit: boolean;
  noCommit: boolean;
  ffOnly: boolean;
};

export function parseMergeFlags(commandArgs: string[]): MergeFlags {
  return {
    abort: commandArgs.includes("--abort"),
    continue: commandArgs.includes("--continue"),
    quit: commandArgs.includes("--quit"),
    noCommit: commandArgs.includes("--no-commit"),
    ffOnly: commandArgs.includes("--ff-only"),
  };
}

export type RebaseFlags = {
  abort: boolean;
  continue: boolean;
  skip: boolean;
  quit: boolean;
  interactive: boolean;
  onto: string | null;
  upstream: string | null;
};

export function parseRebaseFlags(commandArgs: string[]): RebaseFlags {
  let onto: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < commandArgs.length; i++) {
    const arg = commandArgs[i];
    if (arg === "--") {
      positional.push(...commandArgs.slice(i + 1));
      break;
    }
    if (arg === "--onto" && commandArgs[i + 1]) {
      onto = commandArgs[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--onto=")) {
      onto = arg.slice("--onto=".length);
      continue;
    }
    if (arg.startsWith("-") && arg !== "-i") continue;
    if (arg === "-i") continue;
    positional.push(arg);
  }
  return {
    abort: commandArgs.includes("--abort"),
    continue: commandArgs.includes("--continue"),
    skip: commandArgs.includes("--skip"),
    quit: commandArgs.includes("--quit"),
    interactive: commandArgs.includes("-i") || commandArgs.includes("--interactive"),
    onto,
    upstream: positional[0] ?? null,
  };
}

export function isControlOp(args: string[]): boolean {
  return ["--abort", "--continue", "--skip", "--quit"].some((flag) => args.includes(flag));
}
