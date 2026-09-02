import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledCli(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : "";
  const candidates = [
    argv1.endsWith(".mjs") ? argv1 : "",
    path.join(here, "nwt.mjs"),
    path.join(here, "..", "dist", "nwt.mjs"),
    path.join(here, "..", ".nwt", "nwt.mjs"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
