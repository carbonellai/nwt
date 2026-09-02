import fs from "node:fs";
import path from "node:path";
import { posixRel } from "./git";
import type { Manifest } from "./types";
import { emptyManifest } from "./types";
import type { HostPaths } from "./paths";

export function loadManifest(paths: HostPaths): Manifest {
  if (!fs.existsSync(paths.manifest)) return emptyManifest();
  const raw = JSON.parse(fs.readFileSync(paths.manifest, "utf8")) as Manifest;
  const empty = emptyManifest();
  return {
    version: raw.version ?? empty.version,
    nested: raw.nested ?? [],
    overlay: {
      paths: raw.overlay?.paths ?? [],
      baseSha: raw.overlay?.baseSha ?? null,
      overlaySha: raw.overlay?.overlaySha ?? null,
    },
  };
}

export function saveManifest(paths: HostPaths, manifest: Manifest): void {
  fs.mkdirSync(paths.nwt, { recursive: true });
  fs.writeFileSync(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function nestedId(relPath: string): string {
  return relPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replaceAll("/", "-")
    .replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

export function gitDirRel(id: string): string {
  return `.nwt/git/${id}.git`;
}

export function sortNested(manifest: Manifest): void {
  manifest.nested.sort((a, b) => a.path.localeCompare(b.path));
}

export function findNestedByPath(manifest: Manifest, rel: string): Manifest["nested"][number] | undefined {
  const normalized = rel.replaceAll("\\", "/").replace(/\/$/, "");
  return manifest.nested.find((entry) => entry.path === normalized);
}

export function hostRelative(root: string, abs: string): string {
  return posixRel(root, abs);
}
