import fs from "node:fs";
import path from "node:path";
import { posixRel } from "./git";
import { loadManifest } from "./manifest";
import { NWT_DIR, MANIFEST_FILE, pathsFor } from "./paths";
import type { NestedRepo } from "./types";

export type NestedResolution = {
  root: string;
  entry: NestedRepo;
};

export function findUmbrellaRoot(start: string): string | null {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, NWT_DIR, MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveNestedFromPath(absPath: string): NestedResolution | null {
  let start = path.resolve(absPath);
  try {
    if (fs.existsSync(start) && fs.statSync(start).isFile()) start = path.dirname(start);
  } catch {
    // path may not exist yet; still resolve prefixes
  }
  const root = findUmbrellaRoot(start);
  if (!root) return null;
  const rel = posixRel(root, start).replaceAll("\\", "/");
  if (rel === "" || rel === ".") return null;
  const manifest = loadManifest(pathsFor(root));
  let best: NestedRepo | null = null;
  for (const entry of manifest.nested) {
    if (rel === entry.path || rel.startsWith(`${entry.path}/`)) {
      if (!best || entry.path.length > best.path.length) best = entry;
    }
  }
  return best ? { root, entry: best } : null;
}
