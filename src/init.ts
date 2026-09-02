import { discoverNested } from "./discover";
import { loadManifest, nestedId, saveManifest, sortNested } from "./manifest";
import { syncOverlay } from "./overlay";
import type { HostPaths } from "./paths";
import { pruneMissingNested } from "./prune";
import { relocateRepo } from "./relocate";
import { applyRules } from "./rules";
import { writeCursorKit } from "./cursor";
import { writeNwtGitHooks } from "./gitHooks";
import { writeProjectGitShim } from "./shimInstall";
import type { Manifest } from "./types";

export async function initHost(paths: HostPaths, opts: { commit?: boolean } = {}): Promise<Manifest> {
  await pruneMissingNested(paths, { commit: opts.commit ?? true });
  const discovered = discoverNested(paths.root);
  const manifest = loadManifest(paths);
  const byPath = new Map(manifest.nested.map((entry) => [entry.path, entry]));

  for (const repo of discovered) {
    const existing = byPath.get(repo.relPath);
    const id = existing?.id ?? nestedId(repo.relPath);
    const gitDir = await relocateRepo(paths.root, repo.relPath, id);
    byPath.set(repo.relPath, { id, path: repo.relPath, gitDir });
  }

  manifest.nested = [...byPath.values()];
  sortNested(manifest);
  saveManifest(paths, manifest);
  writeCursorKit(paths.root);
  writeProjectGitShim(paths.root);
  await writeNwtGitHooks(paths.root);
  await applyRules(paths, manifest);
  await syncOverlay(paths, manifest, { commit: opts.commit ?? true });
  await pruneMissingNested(paths, { commit: opts.commit ?? true });
  return loadManifest(paths);
}

export function printDiscover(paths: HostPaths): void {
  const found = discoverNested(paths.root);
  if (found.length === 0) {
    console.log("nwt: no nested git repositories found");
    return;
  }
  for (const repo of found) {
    console.log(repo.relPath);
  }
}
