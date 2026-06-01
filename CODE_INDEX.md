# Code Index

> Capability index — what the codebase can do, not where files live.
> Refresh: `/mtk audit duplicates`.
> Last built: 2026-05-29

## Persistence & State (`~/.work/`)

| Capability | Entry point | Notes |
|---|---|---|
| Atomic file write (tmp + rename) | `src/core/fs-safe.ts:atomicWriteFile` | Use for all persisted JSON state — don't bare `writeFileSync`. |
| Cross-process file lock | `src/core/fs-safe.ts:withFileLock` | proper-lockfile advisory lock; wraps read-modify-write. |
| Ensure file exists before locking | `src/core/fs-safe.ts:ensureFile` | Call before `withFileLock`. |
| Load/save config | `src/core/config.ts:loadConfig` / `saveConfig` | `~/.work/config.json`. `saveConfig` is not yet atomic (see arch §10). |
| Load/save session history | `src/core/history.ts:loadHistory` / `saveHistory` | Atomic + locked. |
| Prune stale history entries | `src/core/history.ts:pruneStaleEntries` | — |

## Git & Worktrees

| Capability | Entry point | Notes |
|---|---|---|
| Run a git subcommand | `src/core/git.ts:git` | argv-based via cross-spawn; no shell string. |
| Parse `git worktree list` | `src/core/git.ts:parseWorktreeList` | — |
| Detect default branch | `src/core/git.ts:getDefaultBranch` | — |
| Check branch merged | `src/core/git.ts:isBranchMerged` | Used by `prune`. |
| Create a worktree | `src/core/worktree.ts:createSingleWorktree` | — |
| Full worktree setup (copy files, hooks) | `src/core/worktree.ts:setupWorktree` | async. |
| Remove / teardown a worktree | `src/core/worktree.ts:removeSingleWorktree` / `teardownWorktree` | — |
| Resolve project/group target | `src/core/resolve.ts:resolveProjectTarget` | — |

## Output & Logging

| Capability | Entry point | Notes |
|---|---|---|
| Mirror console to `~/.work/debug.log` | `src/core/logger.ts:installConsoleLogger` | Installed in `src/bin.ts`. |
| Structured debug log | `src/core/logger.ts:debug` / `debugLog` | — |
| Generate group CLAUDE.md for a worktree | `src/core/claude-md.ts:generateGroupClaudeMd` | NOT this repo's root CLAUDE.md. |
