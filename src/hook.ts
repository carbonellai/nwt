import { createBranchEverywhere, worktreeAdd } from "./cascade";
import type { HostPaths } from "./paths";
import { pruneMissingNested } from "./prune";

type Payload = {
  command?: string;
};

export async function handleAfterShell(paths: HostPaths, payload: Payload): Promise<void> {
  const command = payload.command ?? "";
  if (!command.trim()) return;
  if (command.includes("nwt.mjs") || /\bnwt\s/.test(command)) return;

  const worktreeMatch = command.match(/\bgit(?:\s+-C\s+\S+)?\s+worktree\s+add\s+(.+)$/);
  if (worktreeMatch && !command.includes(".nwt/nwt")) {
    const tokens = tokenize(worktreeMatch[1]);
    const dashB = tokens.indexOf("-b");
    let branch: string | undefined;
    const positional = tokens.filter((tok, i) => tok !== "-b" && (dashB === -1 || i !== dashB + 1) && !tok.startsWith("-"));
    if (dashB !== -1 && tokens[dashB + 1]) branch = tokens[dashB + 1];
    const dest = positional[0];
    if (dest) {
      try {
        await worktreeAdd(paths, dest, branch ?? positional[1], { skipRoot: true });
      } catch (error) {
        console.warn(`nwt hook: worktree cascade failed: ${String(error)}`);
      }
    }
    await pruneMissingNested(paths, { commit: true });
    return;
  }

  const branchCreate = command.match(/\bgit(?:\s+-C\s+\S+)?\s+branch\s+(?!-|-d|-D|-m|--list|--show-current)([^\s]+)/);
  if (branchCreate && !/\b(branch\s+(-a|-r|--list))\b/.test(command)) {
    const name = branchCreate[1];
    if (name && !name.startsWith("-")) {
      try {
        await createBranchEverywhere(paths, name);
      } catch (error) {
        console.warn(`nwt hook: branch cascade failed: ${String(error)}`);
      }
    }
  }

  await pruneMissingNested(paths, { commit: true });
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

export async function readStdinJson<T>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}
