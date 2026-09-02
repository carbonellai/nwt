import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { worktreeAdd } from "../src/cascade";
import { discoverNested } from "../src/discover";
import { git, gitOk } from "../src/git";
import { scopeGitignore } from "../src/ignore";
import { initHost } from "../src/init";
import { installInto } from "../src/install";
import { loadManifest } from "../src/manifest";
import { pathsFor } from "../src/paths";
import { destroyNestedFixtures, dirtyNestedFixtures, spawnNestedFixtures } from "./fixtures";
import { pruneMissingNested, SKIP_PRUNE_ENV } from "../src/prune";
import { nestedGitDir, nestedWorkTree } from "../src/relocate";
import { runShimGit } from "../src/shimGit";
import { assertSafeShimTarget, installUserShim, uninstallUserShim } from "../src/shimInstall";

function samePath(a: string, b: string): boolean {
  return fs.realpathSync(a) === fs.realpathSync(b);
}

const temps: string[] = [];

after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nwt-root-"));
  temps.push(dir);
  await git(["init"], { cwd: dir });
  await git(["config", "user.email", "nwt@test"], { cwd: dir });
  await git(["config", "user.name", "nwt"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "ROOT.md"), "umbrella\n");
  await git(["add", "ROOT.md"], { cwd: dir });
  await git(["commit", "-m", "root"], { cwd: dir });
  return dir;
}

async function makeNested(root: string, rel: string, body = "hello\n"): Promise<string> {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(abs, { recursive: true });
  await git(["init"], { cwd: abs });
  await git(["config", "user.email", "nwt@test"], { cwd: abs });
  await git(["config", "user.name", "nwt"], { cwd: abs });
  fs.writeFileSync(path.join(abs, "file.txt"), body);
  fs.writeFileSync(path.join(abs, ".gitignore"), "secret.tmp\n");
  fs.writeFileSync(path.join(abs, "secret.tmp"), "ignored-secret\n");
  await git(["add", "file.txt", ".gitignore"], { cwd: abs });
  await git(["commit", "-m", `init ${rel}`], { cwd: abs });
  return abs;
}

test("scopeGitignore prefixes nested patterns", () => {
  const scoped = scopeGitignore("secret.tmp\n/dist\nnode_modules/\n", "vendor/lib");
  assert.deepEqual(scoped, [
    "vendor/lib/**/secret.tmp",
    "vendor/lib/dist",
    "vendor/lib/node_modules/",
  ]);
});

test("discover finds deeply nested clones", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await makeNested(root, "deep/nested/tool");
  const found = discoverNested(root).map((item) => item.relPath);
  assert.deepEqual(found, ["deep/nested/tool", "packages/a"]);
});

test("init relocates git dirs and overlays dirty nested files", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  assert.equal(fs.existsSync(path.join(root, "packages/a/.git")), false);
  const manifest = loadManifest(paths);
  assert.equal(manifest.nested.length, 1);
  assert.equal(fs.existsSync(path.join(root, manifest.nested[0].gitDir)), true);

  fs.appendFileSync(path.join(root, "packages/a/file.txt"), "dirty-line\n");
  fs.writeFileSync(path.join(root, "packages/a/secret.tmp"), "still-ignored\n");

  const { stdout } = await git(["status", "--porcelain"], { cwd: root });
  assert.match(stdout, /packages\/a\/file\.txt/);
  assert.doesNotMatch(stdout, /secret\.tmp/);
});

test("parent branch cascades; nested branch does not go up", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const { createBranchEverywhere } = await import("../src/cascade");
  await createBranchEverywhere(paths, "feature-x");
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  assert.equal(await gitOk(["show-ref", "--verify", "--quiet", "refs/heads/feature-x"], { cwd: root }), true);
  assert.equal(await gitOk(["show-ref", "--verify", "--quiet", "refs/heads/feature-x"], { gitDir }), true);

  await git(["branch", "only-nested"], {
    gitDir,
    workTree: nestedWorkTree(root, "packages/a"),
  });
  assert.equal(await gitOk(["show-ref", "--verify", "--quiet", "refs/heads/only-nested"], { cwd: root }), false);
});

test("worktree add at root creates nested worktree of the same branch", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const wt = path.join(os.tmpdir(), `nwt-wt-${Date.now()}`);
  temps.push(wt);
  await worktreeAdd(paths, wt, "feature-wt");
  assert.equal(await gitOk(["show-ref", "--verify", "--quiet", "refs/heads/feature-wt"], { cwd: root }), true);
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  assert.equal(await gitOk(["show-ref", "--verify", "--quiet", "refs/heads/feature-wt"], { gitDir }), true);
  assert.equal(fs.existsSync(path.join(wt, "packages/a/file.txt")), true);
  assert.equal(fs.existsSync(path.join(wt, "packages/a/.git")), false);
});

test("spawn dirty destroy cycle uses a random nested prefix", async () => {
  const root = await tempRoot();
  const paths = pathsFor(root);
  const spawned = await spawnNestedFixtures(paths, { count: 2, depth: 2 });
  assert.match(spawned.spawnDir, /^[a-z]{6,12}$/);
  assert.notEqual(spawned.spawnDir, "playground");
  assert.notEqual(spawned.spawnDir, "examples");
  const dirty = await dirtyNestedFixtures(paths, spawned.repos);
  assert.ok(dirty.length >= 2);
  const { stdout } = await git(["status", "--porcelain"], { cwd: root });
  for (const file of dirty) {
    assert.ok(stdout.includes(file), `expected ${file} in status:\n${stdout}`);
  }
  await destroyNestedFixtures(paths, spawned.repos);
  assert.equal(fs.existsSync(path.join(root, spawned.spawnDir)), false);
  assert.equal(fs.existsSync(path.join(root, "playground")), false);
});

test("nwt install copies the bundled CLI", async () => {
  const kitCli = path.join(process.cwd(), "dist", "nwt.mjs");
  if (!fs.existsSync(kitCli)) {
    console.log("skip install test: dist/nwt.mjs not built");
    return;
  }
  const target = await tempRoot();
  await makeNested(target, "lib/child");
  await installInto(target);
  assert.equal(fs.existsSync(path.join(target, ".nwt", "nwt.mjs")), true);
  assert.equal(fs.existsSync(path.join(target, ".cursor", "hooks.json")), true);
  assert.equal(fs.existsSync(path.join(target, "lib/child/.git")), false);
  assert.equal(fs.existsSync(path.join(target, ".nwt", "bin", "git")), true);
  const settings = JSON.parse(fs.readFileSync(path.join(target, ".vscode", "settings.json"), "utf8")) as {
    "terminal.integrated.env.osx"?: { PATH?: string };
  };
  assert.match(settings["terminal.integrated.env.osx"]?.PATH ?? "", /\.nwt\/bin/);
  assert.equal(fs.existsSync(path.join(target, ".cursor", "scripts", "nwt-after-shell.sh")), true);
  const hooks = JSON.parse(fs.readFileSync(path.join(target, ".cursor", "hooks.json"), "utf8")) as {
    hooks?: { sessionStart?: { command?: string }[] };
  };
  assert.ok((hooks.hooks?.sessionStart?.length ?? 0) > 0);
  assert.match(hooks.hooks?.sessionStart?.[0]?.command ?? "", /\.cursor\/scripts\//);
});

test("dist CLI prints usage without playground", () => {
  const cli = path.join(process.cwd(), "dist", "nwt.mjs");
  assert.equal(fs.existsSync(cli), true, "dist/nwt.mjs should exist after pretest build");
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nwt install/);
  assert.match(result.stdout, /nwt init/);
  assert.doesNotMatch(result.stdout, /playground/i);
});

test("umbrella commit of a nested file lands in that clone", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const nested = path.join(root, "packages/a");
  const gitDir = nestedGitDir(root, loadManifest(pathsFor(root)).nested[0].gitDir);
  fs.appendFileSync(path.join(nested, "file.txt"), "from-umbrella\n");
  await git(["add", "packages/a/file.txt"], { cwd: root });
  const committed = await runShimGit(["commit", "-m", "nested fix"], { cwd: root, inherit: false });
  assert.equal(committed.code, 0, committed.stderr);

  const nestedMsg = await git(["log", "-1", "--format=%s"], { gitDir });
  assert.equal(nestedMsg.stdout.trim(), "nested fix");
  const nestedStatus = await git(["status", "--porcelain"], {
    gitDir,
    workTree: nested,
  });
  assert.equal(nestedStatus.stdout.trim(), "");
  assert.equal(fs.existsSync(path.join(nested, ".git")), false);

  const umbrella = await git(["status", "--porcelain", "--", "packages/a/file.txt"], { cwd: root });
  assert.equal(umbrella.stdout.trim(), "");
});

test("mixed commit splits nested and umbrella files", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const gitDir = nestedGitDir(root, loadManifest(pathsFor(root)).nested[0].gitDir);
  fs.appendFileSync(path.join(root, "packages/a/file.txt"), "nested-bit\n");
  fs.appendFileSync(path.join(root, "ROOT.md"), "umbrella-bit\n");
  await git(["add", "packages/a/file.txt", "ROOT.md"], { cwd: root });
  const committed = await runShimGit(["commit", "-m", "mixed change"], { cwd: root, inherit: false });
  assert.equal(committed.code, 0, committed.stderr);
  const nestedMsg = await git(["log", "-1", "--format=%s"], { gitDir });
  assert.equal(nestedMsg.stdout.trim(), "mixed change");
  const umbrellaMsg = await git(["log", "-1", "--format=%s"], { cwd: root });
  assert.equal(umbrellaMsg.stdout.trim(), "mixed change");
  const rootShow = await git(["show", "--name-only", "--pretty=format:", "HEAD"], { cwd: root });
  assert.match(rootShow.stdout, /ROOT\.md/);
});

test("commit --amend updates nested HEAD", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const gitDir = nestedGitDir(root, loadManifest(pathsFor(root)).nested[0].gitDir);
  fs.appendFileSync(path.join(root, "packages/a/file.txt"), "v1\n");
  await git(["add", "packages/a/file.txt"], { cwd: root });
  assert.equal((await runShimGit(["commit", "-m", "first"], { cwd: root, inherit: false })).code, 0);
  fs.appendFileSync(path.join(root, "packages/a/file.txt"), "v2\n");
  await git(["add", "packages/a/file.txt"], { cwd: root });
  const amended = await runShimGit(["commit", "--amend", "-m", "amended"], { cwd: root, inherit: false });
  assert.equal(amended.code, 0, amended.stderr);
  const nestedMsg = await git(["log", "-1", "--format=%s"], { gitDir });
  assert.equal(nestedMsg.stdout.trim(), "amended");
  const count = await git(["rev-list", "--count", "HEAD"], { gitDir });
  assert.equal(count.stdout.trim(), "2");
});

test("merge at umbrella merges the nested clone", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const paths = pathsFor(root);
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  const workTree = nestedWorkTree(root, "packages/a");
  const { createBranchEverywhere } = await import("../src/cascade");
  await createBranchEverywhere(paths, "feature");
  await git(["checkout", "feature"], { cwd: root });
  await git(["checkout", "feature"], { gitDir, workTree });
  fs.appendFileSync(path.join(workTree, "file.txt"), "on-feature\n");
  await git(["add", "packages/a/file.txt"], { cwd: root });
  assert.equal((await runShimGit(["commit", "-m", "feature work"], { cwd: root, inherit: false })).code, 0);
  await git(["checkout", "main"], { cwd: root });
  await git(["checkout", "main"], { gitDir, workTree, allowFail: true });
  const merged = await runShimGit(["merge", "feature", "-m", "merge feature"], { cwd: root, inherit: false });
  assert.equal(merged.code, 0, merged.stderr);
  const nestedLog = await git(["log", "--oneline", "-3"], { gitDir });
  assert.match(nestedLog.stdout, /feature work/);
  const body = fs.readFileSync(path.join(workTree, "file.txt"), "utf8");
  assert.match(body, /on-feature/);
});

test("merge --abort clears nested MERGE_HEAD", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const paths = pathsFor(root);
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  const workTree = nestedWorkTree(root, "packages/a");
  const { createBranchEverywhere } = await import("../src/cascade");
  await createBranchEverywhere(paths, "feature");
  await git(["checkout", "feature"], { gitDir, workTree });
  fs.writeFileSync(path.join(workTree, "file.txt"), "feature-side\n");
  await git(["add", "file.txt"], { gitDir, workTree });
  await git(["commit", "-m", "feature conflict"], { gitDir, workTree });
  await git(["checkout", "main"], { gitDir, workTree });
  fs.writeFileSync(path.join(workTree, "file.txt"), "main-side\n");
  await git(["add", "file.txt"], { gitDir, workTree });
  await git(["commit", "-m", "main conflict"], { gitDir, workTree });
  const merge = await runShimGit(["merge", "feature"], { cwd: root, inherit: false });
  assert.notEqual(merge.code, 0);
  const aborted = await runShimGit(["merge", "--abort"], { cwd: root, inherit: false });
  assert.equal(aborted.code, 0, aborted.stderr);
  const merging = await gitOk(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { gitDir });
  assert.equal(merging, false);
});

test("rebase at umbrella rebases the nested clone", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const paths = pathsFor(root);
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  const workTree = nestedWorkTree(root, "packages/a");
  const { createBranchEverywhere } = await import("../src/cascade");
  await git(["checkout", "-b", "feature"], { gitDir, workTree });
  fs.appendFileSync(path.join(workTree, "file.txt"), "feature-line\n");
  await git(["add", "file.txt"], { gitDir, workTree });
  await git(["commit", "-m", "feature commit"], { gitDir, workTree });
  await git(["checkout", "main"], { gitDir, workTree });
  fs.writeFileSync(path.join(workTree, "other.txt"), "main-only\n");
  await git(["add", "other.txt"], { gitDir, workTree });
  await git(["commit", "-m", "main extra"], { gitDir, workTree });
  await createBranchEverywhere(paths, "feature");
  await git(["checkout", "feature"], { gitDir, workTree });
  await git(["checkout", "-B", "feature"], { cwd: root, allowFail: true });
  const rebased = await runShimGit(["rebase", "main"], { cwd: root, inherit: false });
  assert.equal(rebased.code, 0, rebased.stderr);
  const onFeature = await git(["merge-base", "--is-ancestor", "main", "HEAD"], { gitDir, allowFail: true });
  assert.equal(onFeature.code, 0);
});

test("interactive rebase keeps nested clean with a passthrough editor", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const gitDir = nestedGitDir(root, loadManifest(pathsFor(root)).nested[0].gitDir);
  const workTree = nestedWorkTree(root, "packages/a");
  fs.appendFileSync(path.join(workTree, "file.txt"), "one\n");
  await git(["add", "packages/a/file.txt"], { cwd: root });
  assert.equal((await runShimGit(["commit", "-m", "one"], { cwd: root, inherit: false })).code, 0);
  fs.appendFileSync(path.join(workTree, "file.txt"), "two\n");
  await git(["add", "packages/a/file.txt"], { cwd: root });
  assert.equal((await runShimGit(["commit", "-m", "two"], { cwd: root, inherit: false })).code, 0);
  const rebased = await runShimGit(["rebase", "-i", "HEAD~2"], {
    cwd: root,
    inherit: false,
    env: { ...process.env, GIT_SEQUENCE_EDITOR: "true" },
  });
  assert.equal(rebased.code, 0, rebased.stderr);
  const nestedStatus = await git(["status", "--porcelain"], { gitDir, workTree });
  assert.equal(nestedStatus.stdout.trim(), "");
});

test("git shim uses nested clone from cwd and -C, pass-through otherwise", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const nested = path.join(root, "packages/a");
  assert.equal(fs.existsSync(path.join(nested, ".git")), false);

  const nestedTop = await runShimGit(["rev-parse", "--show-toplevel"], {
    cwd: nested,
    inherit: false,
  });
  assert.equal(nestedTop.code, 0, nestedTop.stderr);
  assert.ok(samePath(nestedTop.stdout.trim(), nested));

  const viaC = await runShimGit(["-C", nested, "rev-parse", "--show-toplevel"], {
    cwd: root,
    inherit: false,
  });
  assert.ok(samePath(viaC.stdout.trim(), nested));

  const src = path.join(nested, "src");
  fs.mkdirSync(src, { recursive: true });
  const fromSrc = await runShimGit(["rev-parse", "--show-prefix"], {
    cwd: src,
    inherit: false,
  });
  assert.equal(fromSrc.stdout.trim(), "src/");

  const stackedC = await runShimGit(["-C", "packages", "-C", "a", "rev-parse", "--show-toplevel"], {
    cwd: root,
    inherit: false,
  });
  assert.ok(samePath(stackedC.stdout.trim(), nested));

  const umbrella = await runShimGit(["rev-parse", "--show-toplevel"], {
    cwd: root,
    inherit: false,
  });
  assert.ok(samePath(umbrella.stdout.trim(), root));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nwt-plain-"));
  temps.push(outside);
  await git(["init"], { cwd: outside });
  const plain = await runShimGit(["rev-parse", "--show-toplevel"], {
    cwd: outside,
    inherit: false,
  });
  assert.ok(samePath(plain.stdout.trim(), outside));
});

test("GIT_DIR pass-through skips nested resolve", async () => {
  const root = await tempRoot();
  await makeNested(root, "packages/a");
  await initHost(pathsFor(root), { commit: true });
  const gitDir = nestedGitDir(root, loadManifest(pathsFor(root)).nested[0].gitDir);
  const workTree = nestedWorkTree(root, "packages/a");
  const result = await runShimGit(["rev-parse", "--show-toplevel"], {
    cwd: root,
    inherit: false,
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: workTree },
  });
  assert.ok(samePath(result.stdout.trim(), workTree));
});

test("user shim install refuses /usr/bin/git and overwrites only nwt shims", async () => {
  assert.throws(() => assertSafeShimTarget("/usr/bin/git", "/usr/bin/git"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nwt-shim-"));
  temps.push(dir);
  const target = path.join(dir, "git");
  fs.writeFileSync(target, "#!/bin/sh\necho not-nwt\n");
  process.env.NWT_SHIM_PATH = target;
  try {
    assert.throws(() => installUserShim(target), /not an nwt shim/);
    fs.rmSync(target);
    const installed = installUserShim(target);
    assert.equal(installed, path.resolve(target));
    const text = fs.readFileSync(target, "utf8");
    assert.match(text, /nwt-git-shim/);
    assert.equal(uninstallUserShim(target), true);
  } finally {
    delete process.env.NWT_SHIM_PATH;
  }
});

test("prune drops one nested clone and keeps a sibling under arbitrary names", async () => {
  const root = await tempRoot();
  await makeNested(root, "vendor/alpha");
  await makeNested(root, "apps/beta");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const bundled = path.join(root, ".nwt", "nwt.mjs");
  const hadCli = fs.existsSync(bundled);
  const alpha = loadManifest(paths).nested.find((entry) => entry.path === "vendor/alpha");
  const beta = loadManifest(paths).nested.find((entry) => entry.path === "apps/beta");
  assert.ok(alpha && beta);
  const alphaGitDir = nestedGitDir(root, alpha.gitDir);
  const betaGitDir = nestedGitDir(root, beta.gitDir);

  fs.rmSync(path.join(root, "vendor/alpha"), { recursive: true, force: true });
  await pruneMissingNested(paths, { commit: true });

  const after = loadManifest(paths);
  assert.equal(after.nested.some((entry) => entry.path === "vendor/alpha"), false);
  assert.equal(after.nested.some((entry) => entry.path === "apps/beta"), true);
  assert.equal(fs.existsSync(alphaGitDir), false);
  assert.equal(fs.existsSync(betaGitDir), true);
  assert.equal(fs.existsSync(path.join(root, "apps/beta/.git")), false);
  assert.equal(after.overlay.paths.some((p) => p.startsWith("vendor/alpha/")), false);
  assert.equal(after.overlay.paths.some((p) => p.startsWith("apps/beta/")), true);
  if (hadCli) assert.equal(fs.existsSync(bundled), true);

  await pruneMissingNested(paths, { commit: true });
  assert.equal(loadManifest(paths).nested.length, 1);

  const status = await runShimGit(["status"], { cwd: root, inherit: false });
  assert.equal(status.code, 0, status.stderr);
});

test("parent directory delete prunes every nested child", async () => {
  const root = await tempRoot();
  await makeNested(root, "group/one");
  await makeNested(root, "group/two");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  fs.rmSync(path.join(root, "group"), { recursive: true, force: true });
  await pruneMissingNested(paths, { commit: true });
  assert.equal(loadManifest(paths).nested.length, 0);
  assert.equal(loadManifest(paths).overlay.paths.length, 0);
});

test("NWT_SKIP_PRUNE leaves a missing nested entry registered", async () => {
  const root = await tempRoot();
  await makeNested(root, "libs/keep");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  fs.rmSync(path.join(root, "libs/keep"), { recursive: true, force: true });
  process.env[SKIP_PRUNE_ENV] = "1";
  try {
    await pruneMissingNested(paths, { commit: true });
    assert.equal(loadManifest(paths).nested.some((entry) => entry.path === "libs/keep"), true);
  } finally {
    delete process.env[SKIP_PRUNE_ENV];
  }
  await pruneMissingNested(paths, { commit: true });
  assert.equal(loadManifest(paths).nested.some((entry) => entry.path === "libs/keep"), false);
});

test("prune in one umbrella worktree keeps the shared gitdir for others", async () => {
  const root = await tempRoot();
  await makeNested(root, "libs/sample-lib");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const gitDirRel = loadManifest(paths).nested[0].gitDir;
  const gitDir = nestedGitDir(root, gitDirRel);
  const keepWt = path.join(os.tmpdir(), `nwt-keep-${Date.now()}`);
  temps.push(keepWt);
  await worktreeAdd(paths, keepWt, "keep-lib");

  assert.equal(fs.existsSync(path.join(keepWt, "libs/sample-lib/file.txt")), true);
  fs.rmSync(path.join(root, "libs/sample-lib"), { recursive: true, force: true });
  await pruneMissingNested(paths, { commit: true });

  const mainManifest = loadManifest(paths);
  assert.equal(mainManifest.nested.some((entry) => entry.path === "libs/sample-lib"), false);
  assert.equal(mainManifest.overlay.paths.some((p) => p.startsWith("libs/sample-lib/")), false);
  assert.equal(fs.existsSync(gitDir), true);
  assert.equal(fs.existsSync(path.join(keepWt, "libs/sample-lib/file.txt")), true);

  const keepManifest = loadManifest(pathsFor(keepWt));
  assert.equal(keepManifest.nested.some((entry) => entry.path === "libs/sample-lib"), true);
  assert.equal(keepManifest.overlay.paths.some((p) => p.startsWith("libs/sample-lib/")), true);

  const keepStatus = await runShimGit(["status", "--porcelain"], {
    cwd: path.join(keepWt, "libs/sample-lib"),
    inherit: false,
  });
  assert.equal(keepStatus.code, 0, keepStatus.stderr);

  const mainShim = await runShimGit(["status"], { cwd: root, inherit: false });
  assert.equal(mainShim.code, 0, mainShim.stderr);
});

test("gitdir is removed after the last nested checkout is gone", async () => {
  const root = await tempRoot();
  await makeNested(root, "libs/sample-lib");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  const keepWt = path.join(os.tmpdir(), `nwt-last-${Date.now()}`);
  temps.push(keepWt);
  await worktreeAdd(paths, keepWt, "last-lib");
  fs.rmSync(path.join(root, "libs/sample-lib"), { recursive: true, force: true });
  await pruneMissingNested(paths, { commit: true });
  assert.equal(fs.existsSync(gitDir), true);
  fs.rmSync(path.join(keepWt, "libs/sample-lib"), { recursive: true, force: true });
  await pruneMissingNested(pathsFor(keepWt), { commit: true });
  await pruneMissingNested(paths, { commit: true });
  assert.equal(fs.existsSync(gitDir), false);
});

test("merging overlay deletions does not wipe a live nested gitdir", async () => {
  const root = await tempRoot();
  await makeNested(root, "libs/sample-lib");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const gitDir = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  const keepWt = path.join(os.tmpdir(), `nwt-merge-keep-${Date.now()}`);
  const dropWt = path.join(os.tmpdir(), `nwt-merge-drop-${Date.now()}`);
  temps.push(keepWt, dropWt);
  await worktreeAdd(paths, keepWt, "keep-merge");
  await worktreeAdd(paths, dropWt, "drop-merge");

  fs.rmSync(path.join(dropWt, "libs/sample-lib"), { recursive: true, force: true });
  await pruneMissingNested(pathsFor(dropWt), { commit: true });
  const dropHead = await git(["log", "-1", "--format=%s"], { cwd: dropWt });
  assert.match(dropHead.stdout, /prune missing nested|sync nested overlay/);

  const merged = await git(["merge", "drop-merge", "-m", "merge drop"], { cwd: root, allowFail: true });
  assert.equal(merged.code === 0 || merged.stdout.includes("CONFLICT") || merged.stderr.includes("CONFLICT"), true, merged.stderr);
  assert.equal(fs.existsSync(gitDir), true);
  assert.equal(fs.existsSync(path.join(keepWt, "libs/sample-lib/file.txt")), true);
});

test("init removes leftover unused gitdirs without touching live ones", async () => {
  const root = await tempRoot();
  await makeNested(root, "apps/beta");
  const paths = pathsFor(root);
  await initHost(paths, { commit: true });
  const live = nestedGitDir(root, loadManifest(paths).nested[0].gitDir);
  const leftover = path.join(root, ".nwt", "git", "stale-gone.git");
  await git(["init", "--bare", leftover]);
  await initHost(paths, { commit: true });
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(live), true);
});


