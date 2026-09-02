import fs from "node:fs";
import path from "node:path";
import { posixRel } from "./git";

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".nwt",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  "coverage",
]);

export type DiscoveredRepo = {
  absPath: string;
  relPath: string;
  gitPath: string;
};

function isGitRepo(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    const stat = fs.lstatSync(gitPath);
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export function discoverNested(root: string): DiscoveredRepo[] {
  const found: DiscoveredRepo[] = [];
  const rootGit = path.join(root, ".git");

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (isGitRepo(abs) && path.join(abs, ".git") !== rootGit) {
        found.push({
          absPath: abs,
          relPath: posixRel(root, abs),
          gitPath: path.join(abs, ".git"),
        });
      }
      walk(abs);
    }
  }

  if (isGitRepo(root)) {
    // Root itself is not nested; still walk children.
  }
  walk(root);
  found.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return found;
}
