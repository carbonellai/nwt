import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_BUNDLE_BYTES = 16_384;

function isVendoredBundle(file: string): boolean {
  if (!file.endsWith("nwt.mjs")) return false;
  if (path.basename(path.dirname(file)) === "bin") return false;
  try {
    return fs.statSync(file).size >= MIN_BUNDLE_BYTES;
  } catch {
    return false;
  }
}

export function resolveBundledCli(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const candidates = [
    argv1,
    path.join(here, "nwt.mjs"),
    path.join(here, "..", "dist", "nwt.mjs"),
    path.join(here, "..", ".nwt", "nwt.mjs"),
  ];
  for (const candidate of candidates) {
    if (candidate && isVendoredBundle(candidate)) return candidate;
  }
  return null;
}
