import fs from "node:fs";
import path from "node:path";
import { resolveBundledCli } from "./bundledCli";
import { writeCursorKit } from "./cursor";
import { initHost } from "./init";
import { pathsFor } from "./paths";
import { writeProjectGitShim } from "./shimInstall";

export async function installInto(target: string): Promise<void> {
  const destRoot = path.resolve(target);
  if (!fs.existsSync(destRoot)) {
    throw new Error(`install target does not exist: ${destRoot}`);
  }
  const sourceCli = resolveBundledCli();
  if (!sourceCli) {
    throw new Error("nwt.mjs is missing. Run npm run build first.");
  }
  const destNwt = path.join(destRoot, ".nwt");
  fs.mkdirSync(destNwt, { recursive: true });
  fs.copyFileSync(sourceCli, path.join(destNwt, "nwt.mjs"));
  try {
    fs.chmodSync(path.join(destNwt, "nwt.mjs"), 0o755);
  } catch {
    // ignore on systems that cannot chmod
  }
  writeCursorKit(destRoot);
  writeProjectGitShim(destRoot);
  await initHost(pathsFor(destRoot), { commit: true });
  console.log(`nwt: installed into ${destRoot}`);
}
