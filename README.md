# Nested Git Worktrees (`nwt`)

Give multi-repo Cursor projects first-class git worktrees and a unified Changes view.

Install the CLI once per machine. Do **not** add `@crbn/nwt` to a host project’s dependencies.

Source: [github.com/carbonellai/nwt](https://github.com/carbonellai/nwt)

Nested clones are whatever is in `.nwt/manifest.json` (`nested[]`) — any path.

```mermaid
flowchart LR
  Nested["nested clone files"] --> Relocate["gitdir under .nwt/git"]
  Relocate --> Overlay["umbrella index overlay"]
  Overlay --> Changes["Agents Changes"]
```

Cursor Agents Changes follows the workspace **root** git tree. nwt relocates nested gitdirs under `.nwt/git/` and **leaves nested `.git` off disk**, then snapshots nested HEAD into the umbrella index. Do not put gitfiles back in nested trees (except `nwt uninstall`).

## Setup

```sh
npm i -g @crbn/nwt
cd /path/to/umbrella
nwt init
```

`npm i -g` also writes `~/.local/bin/git` (nwt marker; never `/usr/bin/git`). Put `~/.local/bin` ahead of `/usr/bin` on `PATH`.

If `nwt` is not found after install, add npm’s global bin to `PATH` or use `npx`:

```sh
export PATH="$(npm prefix -g)/bin:$PATH"
# or:
npx @crbn/nwt init
```

Do not run `npx nwt`. Hosts need Node 18+ and Git; they do not need to be Node projects.

`nwt init` discovers nested clones, relocates gitdirs, merges Cursor `hooks.json` / `worktrees.json`, pins git scan settings, vendors `.nwt/nwt.mjs` for hooks, and builds the overlay.

To initialize another directory from anywhere: `nwt install /path/to/umbrella`.

## Git shim

```mermaid
flowchart TD
  Cmd["git ..."] --> Shim["nwt git on PATH"]
  Shim --> Nested{"cwd under a nested path?"}
  Nested -->|yes| Clone["that clone"]
  Nested -->|no| Umbrella["umbrella"]
  Umbrella --> Split["commit / merge / rebase by owning path"]
```

The user-level shim is installed with the global CLI. Open a new terminal. `GIT_DIR` / `--git-dir` pass through. Real git is `NWT_REAL_GIT` or the first non-shim `git` on PATH.

Umbrella `commit`, `commit --amend`, `merge`, and `rebase` land in the clone that owns the files. Nested git never merges or rebases the umbrella. Overlay refresh follows.

`.nwt/bin/git` plus Cursor PATH and `sessionStart` are backups. Hardcoded `/usr/bin/git` is not intercepted.

```sh
nwt git status
nwt git -C packages/a status
```

If npm was installed with `--ignore-scripts`, run `nwt shim-install` once (and `nwt shim-uninstall` later).

## Cascade

```mermaid
flowchart TB
  Root["umbrella worktree / branch"] --> Down["same name in every nested clone"]
  NestedOp["nested worktree / branch"] --> NestedOnly["stays in that clone"]
```

Root worktree/branch creation cascades **down**. Nested ops do not go up.

Cursor `/worktree` setup runs `.cursor/scripts/nwt-setup-worktree.sh`. `afterShellExecution` (`.cursor/scripts/nwt-after-shell.sh`) is a backup. Parent `.cursor/rules` copy into nested clones under `.cursor/rules/inherited/` with a `globs` prefix.

## Prune

```mermaid
flowchart LR
  Gone["folder gone in this worktree"] --> Local["drop overlay / gitignore / shim here"]
  Local --> Shared{"any worktree still has checkout?"}
  Shared -->|yes| Keep["keep .nwt/git/id.git"]
  Shared -->|no| Drop["delete gitdir"]
```

Opportunistic: git shim, `afterShell` (any command), `sessionStart`, `nwt init` / `sync` / `prune`. `post-commit` / `post-merge` in `.nwt/hooks` backup `/usr/bin/git` only. No Husky; existing `core.hooksPath` is not overwritten.

Prune is **worktree-local** for overlay/shim/manifest. The gitdir is shared and is removed only when no umbrella worktree still has that checkout. `NWT_SKIP_PRUNE=1` during `worktree add` / `setup-worktree`.

## Uninstall

Restores nested `.git` **directories** in each umbrella worktree. Does not rewrite overlay history, delete nested repos, or remove `~/.local/bin/git`.

```sh
nwt uninstall                 # each umbrella; or node .nwt/nwt.mjs uninstall
npm uninstall -g @crbn/nwt    # also drops ~/.local/bin/git if it’s nwt’s
```

If the global CLI is removed first: terminal `git` is no longer intercepted; Cursor `.nwt/bin` still is; hosts stay nwt-shaped until `node .nwt/nwt.mjs uninstall`.

## Commands

```sh
nwt discover
nwt init
nwt uninstall
nwt prune
nwt shim-install
nwt worktree add ../app-feature-x feature-x
nwt worktree remove ../app-feature-x
nwt branch feature-x
nwt git [-C path] status
nwt sync --commit
nwt rules apply
```
