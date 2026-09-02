import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { findRealGit, SKIP_SPLIT_ENV } from "./realGit";

const execFileAsync = promisify(execFile);

export type GitOptions = {
  cwd?: string;
  gitDir?: string;
  workTree?: string;
  stdin?: string | Buffer;
  allowFail?: boolean;
  env?: NodeJS.ProcessEnv;
};

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly stdout: string,
    readonly code: number | null,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr || stdout}`);
    this.name = "GitError";
  }
}

function gitBin(opts: GitOptions): string {
  return findRealGit({ ...process.env, ...opts.env });
}

function gitEnv(opts: GitOptions, forceEditor = true): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    [SKIP_SPLIT_ENV]: "1",
    NWT_REAL_GIT: gitBin(opts),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (forceEditor) {
    env.GIT_EDITOR = opts.env?.GIT_EDITOR ?? process.env.GIT_EDITOR ?? "true";
  }
  return env;
}

function forwardArgs(opts: GitOptions, args: string[]): string[] {
  const forwarded: string[] = ["-c", "commit.gpgsign=false"];
  if (opts.gitDir) forwarded.push(`--git-dir=${opts.gitDir}`);
  if (opts.workTree) forwarded.push(`--work-tree=${opts.workTree}`);
  return [...forwarded, ...args];
}

export async function gitRaw(
  args: string[],
  opts: GitOptions = {},
): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  const allArgs = forwardArgs(opts, args);
  if (opts.stdin !== undefined) {
    return gitWithStdin(allArgs, opts);
  }
  try {
    const result = await execFileAsync(gitBin(opts), allArgs, {
      cwd: opts.cwd,
      env: gitEnv(opts),
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      stdout: Buffer.from(result.stdout ?? []),
      stderr: Buffer.from(result.stderr ?? []),
      code: 0,
    };
  } catch (error) {
    const err = error as {
      stdout?: Buffer;
      stderr?: Buffer;
      code?: number | string;
    };
    const stdout = Buffer.from(err.stdout ?? []);
    const stderr = Buffer.from(err.stderr ?? []);
    const code = typeof err.code === "number" ? err.code : 1;
    if (opts.allowFail) return { stdout, stderr, code };
    throw new GitError(allArgs, stderr.toString("utf8"), stdout.toString("utf8"), code);
  }
}

function gitWithStdin(
  allArgs: string[],
  opts: GitOptions,
): Promise<{ stdout: Buffer; stderr: Buffer; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBin(opts), allArgs, {
      cwd: opts.cwd,
      env: gitEnv(opts),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code: code ?? 1,
      };
      if (result.code !== 0 && !opts.allowFail) {
        reject(
          new GitError(
            allArgs,
            result.stderr.toString("utf8"),
            result.stdout.toString("utf8"),
            result.code,
          ),
        );
        return;
      }
      resolve(result);
    });
    child.stdin.end(opts.stdin ?? Buffer.alloc(0));
  });
}

export async function git(
  args: string[],
  opts: GitOptions = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await gitRaw(args, opts);
  return {
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    code: result.code,
  };
}

export async function spawnRealGit(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; inherit?: boolean },
): Promise<{ stdout: string; stderr: string; code: number }> {
  const inherit = opts.inherit ?? false;
  const env: GitOptions["env"] = {
    ...opts.env,
    [SKIP_SPLIT_ENV]: opts.env?.[SKIP_SPLIT_ENV] ?? "1",
  };
  const bin = gitBin({ env });
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-c", "commit.gpgsign=false", ...args], {
      cwd: opts.cwd,
      env: { ...gitEnv({ env }, false), ...opts.env, NWT_REAL_GIT: bin },
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    if (!inherit) {
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

export async function gitLines(
  args: string[],
  opts: GitOptions = {},
): Promise<string[]> {
  const { stdout } = await git(args, opts);
  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export async function gitOk(args: string[], opts: GitOptions = {}): Promise<boolean> {
  const result = await git(args, { ...opts, allowFail: true });
  return result.code === 0;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  return gitOk(["rev-parse", "HEAD"], { cwd });
}

export async function ensureHead(cwd: string): Promise<string> {
  if (await hasCommits(cwd)) {
    const { stdout } = await git(["rev-parse", "HEAD"], { cwd });
    return stdout.trim();
  }
  await git(["commit", "--allow-empty", "-m", "nwt: empty base"], { cwd });
  const { stdout } = await git(["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

export async function revParse(cwd: string, rev = "HEAD"): Promise<string> {
  const { stdout } = await git(["rev-parse", rev], { cwd });
  return stdout.trim();
}

export async function currentBranch(cwd: string, opts: GitOptions = {}): Promise<string> {
  const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    ...opts,
  });
  return stdout.trim();
}

export async function toplevel(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "--show-toplevel"], { cwd, allowFail: true });
  if (result.code !== 0) return null;
  return result.stdout.trim();
}

export function posixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

export function absFromRel(root: string, rel: string): string {
  return path.resolve(root, ...rel.split("/"));
}

export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}
