# Code Index

> Capability index — what the codebase can do, not where files live.
> Refresh: `/mtk audit duplicates`.
> Last built: 2026-05-29

## Persistence & State (`~/.work/`)

| Capability | Entry point | Notes |
|---|---|---|
| Atomic file write (tmp + rename) | `src/core/platform/fs-safe.ts:atomicWriteFile` | Use for all persisted JSON state — don't bare `writeFileSync`. |
| Cross-process file lock | `src/core/platform/fs-safe.ts:withFileLock` | proper-lockfile advisory lock; wraps read-modify-write. |
| Ensure file exists before locking | `src/core/platform/fs-safe.ts:ensureFile` | Call before `withFileLock`. |
| Load/save config | `src/core/platform/config.ts:loadConfig` / `saveConfig` | `~/.work/config.json`. `saveConfig` is not yet atomic (see arch §10). |
| Load/save session history | `src/core/sessions/history.ts:loadHistory` / `saveHistory` | Atomic + locked. |
| Prune stale history entries | `src/core/sessions/history.ts:pruneStaleEntries` | — |

## Git & Worktrees

| Capability | Entry point | Notes |
|---|---|---|
| Run a git subcommand | `src/core/git/git.ts:git` | argv-based via cross-spawn; no shell string. |
| Parse `git worktree list` | `src/core/git/git.ts:parseWorktreeList` | — |
| Detect default branch | `src/core/git/git.ts:getDefaultBranch` | — |
| Check branch merged | `src/core/git/git.ts:isBranchMerged` | Used by `prune`. |
| Create a worktree | `src/core/worktree/worktree.ts:createSingleWorktree` | — |
| Full worktree setup (copy files, hooks) | `src/core/worktree/worktree.ts:setupWorktree` | async. |
| Remove / teardown a worktree | `src/core/worktree/worktree.ts:removeSingleWorktree` / `teardownWorktree` | — |
| Resolve project/group target | `src/core/worktree/resolve.ts:resolveProjectTarget` | — |

## Output & Logging

| Capability | Entry point | Notes |
|---|---|---|
| Mirror console to `~/.work/debug.log` | `src/core/platform/logger.ts:installConsoleLogger` | Installed in `src/bin.ts`. |
| Structured debug log | `src/core/platform/logger.ts:debug` / `debugLog` | — |
| Generate group CLAUDE.md for a worktree | `src/core/claude-md.ts:generateGroupClaudeMd` | NOT this repo's root CLAUDE.md. |
