import fs from "node:fs";
import { createBranchEverywhere, setupWorktree, worktreeAdd, worktreeList, worktreeRemove } from "./cascade";
import { handleAfterShell, readStdinJson } from "./hook";
import { initHost, printDiscover } from "./init";
import { installInto } from "./install";
import { loadManifest } from "./manifest";
import { handlePostCommit, handlePostMerge, handlePostRewrite, runSequenceEditor } from "./owningGit";
import { handlePreRebase, mergeNestedFromMessage } from "./owningCascade";
import { syncOverlay } from "./overlay";
import { pathsFor, resolveHost } from "./paths";
import { listUmbrellaWorktrees, pruneMissingNested } from "./prune";
import { applyRules } from "./rules";
import { findUmbrellaRoot } from "./resolve";
import { runShimGit } from "./shimGit";
import {
  installUserShim,
  lifecycleInstallUserShim,
  lifecycleUninstallUserShim,
  shimInstallHint,
  uninstallUserShim,
} from "./shimInstall";
import { uninstallHost } from "./uninstall";

function usage(): string {
  return `nwt — nested git worktrees kit

Usage:
  nwt install <project>
  nwt discover
  nwt init
  nwt uninstall [--commit|--no-commit] [--all-worktrees]
  nwt shim-install [path]
  nwt shim-uninstall [path]
  nwt worktree add <path> [branch]
  nwt worktree remove <path>
  nwt worktree list
  nwt branch <name>
  nwt git [-C <path>] [--] <git-args...>
  nwt sync [--commit]
  nwt prune
  nwt setup-worktree
  nwt rules apply
`;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function firstPathArg(args: string[]): string | undefined {
  return args.find((arg) => arg !== "--" && !arg.startsWith("--"));
}

function sessionStartPayload(cwd = process.cwd()): string {
  const root = findUmbrellaRoot(cwd);
  const bin = root ? `${root}/.nwt/bin` : "";
  const pathEnv = process.env.PATH ?? "";
  const nextPath = bin && !pathEnv.split(":").includes(bin) ? `${bin}:${pathEnv}` : pathEnv;
  return `${JSON.stringify({ env: { PATH: nextPath } })}\n`;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    process.stdout.write(usage());
    return 0;
  }

  if (cmd === "install") {
    if (!rest[0]) throw new Error("nwt install requires a project path");
    await installInto(rest[0]);
    return 0;
  }

  if (cmd === "git") {
    const gitArgs = rest[0] === "--" ? rest.slice(1) : rest;
    const result = await runShimGit(gitArgs, { inherit: true });
    return result.code;
  }

  if (cmd === "shim-install") {
    if (hasFlag(rest, "--lifecycle")) {
      lifecycleInstallUserShim(firstPathArg(rest));
      return 0;
    }
    const installed = installUserShim(firstPathArg(rest));
    console.log(shimInstallHint(installed));
    return 0;
  }

  if (cmd === "shim-uninstall") {
    if (hasFlag(rest, "--lifecycle")) {
      lifecycleUninstallUserShim(firstPathArg(rest));
      return 0;
    }
    const removed = uninstallUserShim(firstPathArg(rest));
    console.log(removed ? "nwt: removed git shim" : "nwt: no shim to remove");
    return 0;
  }

  if (cmd === "hook-session-start") {
    const host = findUmbrellaRoot(process.cwd());
    if (host) await pruneMissingNested(pathsFor(host), { commit: true });
    process.stdout.write(sessionStartPayload());
    return 0;
  }

  if (cmd === "hook-sequence-editor") {
    return runSequenceEditor(rest[0] ?? "");
  }

  if (cmd === "hook-post-commit") {
    await handlePostCommit(await resolveHost(process.cwd()));
    return 0;
  }

  if (cmd === "hook-post-merge") {
    const host = await resolveHost(process.cwd());
    await mergeNestedFromMessage(host);
    await handlePostMerge(host);
    return 0;
  }

  if (cmd === "hook-post-rewrite") {
    await handlePostRewrite(await resolveHost(process.cwd()), rest[0] ?? "");
    return 0;
  }

  if (cmd === "hook-pre-rebase") {
    return handlePreRebase(await resolveHost(process.cwd()), rest[0] ?? "HEAD");
  }

  const root = await resolveHost(process.cwd());
  const paths = pathsFor(root);

  switch (cmd) {
    case "discover":
      printDiscover(paths);
      return 0;
    case "init":
      await initHost(paths, { commit: true });
      console.log(`nwt: initialized ${root} (${loadManifest(paths).nested.length} nested repos)`);
      return 0;
    case "uninstall":
    case "deinit": {
      const commit = hasFlag(rest, "--no-commit") ? false : true;
      const roots = hasFlag(rest, "--all-worktrees")
        ? await listUmbrellaWorktrees(root)
        : [root];
      for (const wt of roots) {
        if (!fs.existsSync(path.join(wt, ".nwt", "manifest.json"))) continue;
        await uninstallHost(pathsFor(wt), { commit });
        console.log(`nwt: uninstalled ${wt}`);
      }
      return 0;
    }
    case "prune": {
      const pruned = await pruneMissingNested(paths, { commit: true });
      console.log(`nwt: prune ${root} (${pruned.nested.length} nested repos)`);
      return 0;
    }
    case "worktree": {
      const sub = rest[0];
      if (sub === "add") {
        if (!rest[1]) throw new Error("nwt worktree add <path> [branch]");
        await worktreeAdd(paths, rest[1], rest[2]);
        return 0;
      }
      if (sub === "remove") {
        if (!rest[1]) throw new Error("nwt worktree remove <path>");
        await worktreeRemove(paths, rest[1]);
        return 0;
      }
      if (sub === "list") {
        process.stdout.write(await worktreeList(paths));
        return 0;
      }
      throw new Error("nwt worktree <add|remove|list>");
    }
    case "branch":
      if (!rest[0]) throw new Error("nwt branch <name>");
      await createBranchEverywhere(paths, rest[0]);
      return 0;
    case "sync":
      await pruneMissingNested(paths, { commit: hasFlag(rest, "--commit") });
      await syncOverlay(paths, loadManifest(paths), { commit: hasFlag(rest, "--commit") });
      return 0;
    case "setup-worktree":
      await setupWorktree(paths);
      return 0;
    case "rules":
      if (rest[0] !== "apply") throw new Error("nwt rules apply");
      await applyRules(paths, loadManifest(paths));
      return 0;
    case "hook-after-shell": {
      const payload = await readStdinJson<{ command?: string }>();
      await handleAfterShell(paths, payload);
      return 0;
    }
    default:
      throw new Error(`unknown command: ${cmd}\n${usage()}`);
  }
}

const args = process.argv.slice(2);
main(args)
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`nwt: ${message}`);
    process.exit(1);
  });
