import fs from "node:fs";
import path from "node:path";
import { ensureHead, git, gitRaw, hasCommits, revParse } from "./git";
import { absFromRel } from "./git";
import { buildGeneratedIgnore, upsertIgnoreBlock } from "./ignore";
import { saveManifest } from "./manifest";
import type { HostPaths } from "./paths";
import { nestedGitDir, nestedWorkTree } from "./relocate";
import type { Manifest } from "./types";

export type OverlayOptions = {
  commit?: boolean;
  message?: string;
  nestedRoot?: string;
  materialize?: boolean;
};

type TreeBlob = { mode: string; sha: string; path: string };

async function listHeadBlobs(gitDir: string): Promise<TreeBlob[]> {
  const result = await git(["ls-tree", "-r", "--full-tree", "-z", "HEAD"], {
    gitDir,
    allowFail: true,
  });
  if (result.code !== 0 || !result.stdout) return [];
  const blobs: TreeBlob[] = [];
  for (const entry of result.stdout.split("\0")) {
    if (!entry) continue;
    const match = entry.match(/^(\d+) blob ([0-9a-f]+)\t(.*)$/);
    if (match) blobs.push({ mode: match[1], sha: match[2], path: match[3] });
  }
  return blobs;
}

async function importBlob(root: string, nestedGitDirPath: string, sha: string): Promise<string> {
  const blob = await gitRaw(["cat-file", "blob", sha], { gitDir: nestedGitDirPath });
  const written = await gitRaw(["hash-object", "-w", "--stdin"], {
    cwd: root,
    stdin: blob.stdout,
  });
  return written.stdout.toString("utf8").trim();
}

function writeGeneratedIgnore(paths: HostPaths, manifest: Manifest, nestedRoot: string): void {
  const entries = manifest.nested.map((entry) => ({
    path: entry.path,
    workTree: nestedWorkTree(nestedRoot, entry.path),
  }));
  const generated = buildGeneratedIgnore(entries);
  fs.mkdirSync(paths.nwt, { recursive: true });
  fs.writeFileSync(paths.generatedIgnore, generated);
  const gitignorePath = path.join(paths.root, ".gitignore");
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const extra = generated
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line &&
        line !== ".nwt/git/" &&
        line !== ".nwt/manifest.json",
    );
  const body = [".nwt/git/", ...extra].join("\n");
  fs.writeFileSync(gitignorePath, upsertIgnoreBlock(current, body));
}

export async function syncOverlay(
  paths: HostPaths,
  manifest: Manifest,
  opts: OverlayOptions = {},
): Promise<Manifest> {
  const nestedRoot = opts.nestedRoot ?? paths.root;
  writeGeneratedIgnore(paths, manifest, nestedRoot);

  const nextPaths: string[] = [];

  for (const entry of manifest.nested) {
    const gitDir = nestedGitDir(nestedRoot, entry.gitDir);
    const blobs = await listHeadBlobs(gitDir);
    for (const blob of blobs) {
      const overlayPath = `${entry.path}/${blob.path}`.replaceAll("//", "/");
      const sha = await importBlob(paths.root, gitDir, blob.sha);
      nextPaths.push(overlayPath);
      if (opts.materialize) {
        const abs = absFromRel(paths.root, overlayPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const raw = await gitRaw(["cat-file", "blob", blob.sha], { gitDir });
        fs.writeFileSync(abs, raw.stdout);
      }
      await git(["update-index", "--add", "--cacheinfo", `${blob.mode},${sha},${overlayPath}`], {
        cwd: paths.root,
      });
    }
  }

  const previous = new Set(manifest.overlay.paths);
  const next = new Set(nextPaths);
  for (const oldPath of previous) {
    if (!next.has(oldPath)) {
      await git(["rm", "--cached", "-f", "--ignore-unmatch", "--", oldPath], {
        cwd: paths.root,
        allowFail: true,
      });
    }
  }

  manifest.overlay.paths = [...next].sort();

  if (opts.commit) {
    if (!manifest.overlay.baseSha) {
      manifest.overlay.baseSha = (await hasCommits(paths.root))
        ? await revParse(paths.root)
        : await ensureHead(paths.root);
    } else {
      await ensureHead(paths.root);
    }
    await git(["add", "--", ".gitignore"], { cwd: paths.root, allowFail: true });
    const result = await git(["diff", "--cached", "--quiet"], { cwd: paths.root, allowFail: true });
    if (result.code !== 0) {
      const committed = await git(
        ["commit", "-m", opts.message ?? "nwt: sync nested overlay"],
        { cwd: paths.root, allowFail: true },
      );
      if (committed.code === 0) {
        manifest.overlay.overlaySha = await revParse(paths.root);
      }
    }
  }

  saveManifest(paths, manifest);
  return manifest;
}

export async function dropOverlayPaths(paths: HostPaths, manifest: Manifest): Promise<void> {
  if (manifest.overlay.paths.length > 0) {
    await git(["rm", "-r", "--cached", "-f", "--ignore-unmatch", "--", ...manifest.overlay.paths], {
      cwd: paths.root,
      allowFail: true,
    });
  }
  manifest.overlay.paths = [];
  saveManifest(paths, manifest);
}

export function overlayWorkTreeFile(root: string, overlayPath: string): string {
  return absFromRel(root, overlayPath);
}
