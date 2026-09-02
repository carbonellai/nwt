import fs from "node:fs";
import path from "node:path";
import { toplevel } from "./git";

export const NWT_DIR = ".nwt";
export const MANIFEST_FILE = "manifest.json";
export const GENERATED_IGNORE = "generated.gitignore";

export type HostPaths = {
  root: string;
  nwt: string;
  manifest: string;
  generatedIgnore: string;
  gitStore: string;
};

export function pathsFor(root: string): HostPaths {
  const nwt = path.join(root, NWT_DIR);
  return {
    root,
    nwt,
    manifest: path.join(nwt, MANIFEST_FILE),
    generatedIgnore: path.join(nwt, GENERATED_IGNORE),
    gitStore: path.join(nwt, "git"),
  };
}

export async function resolveHost(start = process.cwd()): Promise<string> {
  let dir = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(dir, NWT_DIR, MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const top = await toplevel(start);
  if (top) return top;
  return path.resolve(start);
}
