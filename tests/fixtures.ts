import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { git } from "../src/git";
import { initHost } from "../src/init";
import type { HostPaths } from "../src/paths";
import { pruneMissingNested } from "../src/prune";

export type NestedFixture = {
  spawnDir: string;
  repos: string[];
};

function randomToken(length = 8): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function rmEmptyParents(root: string, rel: string): void {
  let dir = path.dirname(path.resolve(root, ...rel.split("/")));
  const stop = path.resolve(root);
  while (dir.startsWith(stop) && dir !== stop) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

async function createNestedRepo(abs: string, label: string): Promise<void> {
  fs.mkdirSync(abs, { recursive: true });
  await git(["init"], { cwd: abs });
  await git(["config", "user.email", "nwt@test"], { cwd: abs });
  await git(["config", "user.name", "nwt"], { cwd: abs });
  fs.writeFileSync(path.join(abs, "README.md"), `# ${label}\n\nnested fixture\n`);
  fs.writeFileSync(path.join(abs, ".gitignore"), "secret.tmp\nignored.log\n");
  fs.writeFileSync(path.join(abs, "secret.tmp"), "should not appear in Changes\n");
  await git(["add", "README.md", ".gitignore"], { cwd: abs });
  await git(["commit", "-m", `init ${label}`], { cwd: abs });
}

function layoutPaths(
  root: string,
  spawnDir: string,
  count: number,
  depth: number,
): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  for (let i = 0; i < count; i++) {
    const segs = [spawnDir];
    if (i === count - 1 && depth > 1) {
      for (let d = 0; d < depth - 1; d++) segs.push(`deep${d + 1}`);
    }
    segs.push(`repo-${String.fromCharCode(97 + i)}`);
    const rel = segs.join("/");
    out.push({ rel, abs: path.join(root, ...segs) });
  }
  return out;
}

export async function spawnNestedFixtures(
  paths: HostPaths,
  opts: { count?: number; depth?: number } = {},
): Promise<NestedFixture> {
  const count = opts.count ?? 3;
  const depth = opts.depth ?? 2;
  const spawnDir = randomToken();
  const layout = layoutPaths(paths.root, spawnDir, count, depth);
  for (const item of layout) {
    await createNestedRepo(item.abs, item.rel);
  }
  await initHost(paths, { commit: true });
  return { spawnDir, repos: layout.map((item) => item.rel) };
}

export async function dirtyNestedFixtures(paths: HostPaths, repos: string[]): Promise<string[]> {
  const dirty: string[] = [];
  for (const rel of repos) {
    const file = path.join(paths.root, ...rel.split("/"), "README.md");
    if (!fs.existsSync(file)) continue;
    fs.appendFileSync(file, `dirty ${rel}\n`);
    dirty.push(`${rel}/README.md`);
  }
  return dirty;
}

export async function destroyNestedFixtures(paths: HostPaths, repos: string[]): Promise<void> {
  for (const rel of repos) {
    const abs = path.join(paths.root, ...rel.split("/"));
    if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
    rmEmptyParents(paths.root, rel);
  }
  await pruneMissingNested(paths, { commit: false });
}
