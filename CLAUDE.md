# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A cross-platform TypeScript CLI (`work2`) for managing git worktrees across multiple repositories. Supports single-repo and multi-repo "group" worktrees with automatic Claude Code launching. Installed globally via `npm link`.

## Development

```bash
npm run build          # Bundle with tsup → dist/bin.js
npm run dev            # Run directly via tsx (no build needed)
npm test               # Run all tests with vitest
npm run test:watch     # Watch mode
npx vitest run tests/core/resolve.test.ts  # Single test file
```

After building, `work2` is available globally (via `npm link`). Rebuild after source changes.

## CLI Commands

```
work2 init                                          # Interactive first-time setup
work2 tree|t <target> <branch> [--open] [--unsafe]  # Create/switch to worktree
work2 remove <target> <branch> [--force]            # Remove worktree
work2 list [target]                                 # List worktrees
work2 status [target] [branch] [--prune]            # Show worktree status
work2 recent [count] [--resume] [--unsafe]          # List/resume recent sessions
work2 prune [--force]                               # Remove merged worktrees
work2 completion [--install]                        # Shell completions

work2 config add <alias> <path>                     # Add a repository
work2 config remove <alias>                         # Remove a repository
work2 config list                                   # List repos and groups
work2 config group add <name> <alias1> <alias2> ... # Create a group
work2 config group remove <name>                    # Remove a group
work2 config group regen <name>                     # Regenerate group CLAUDE.md
work2 config show                                   # Show raw config JSON
work2 config edit                                   # Open config in editor
```

## Architecture

### Module Flow

```
bin.ts → cli.ts (yargs router) → commands/{tree,remove,list,status,recent,prune,config,init}.ts
                                       ↓
                                  core/worktree.ts (atomic operations)
                                  ├── core/git.ts (git wrapper)
                                  ├── core/copy-files.ts (glob-based file copying)
                                  ├── core/resolve.ts (group vs repo dispatch)
                                  ├── core/history.ts (session tracking)
                                  └── core/setup-completions.ts (shell profile detection & install)
```

### Key Design

- **Atomic building blocks:** `createSingleWorktree()` and `removeSingleWorktree()` in `core/worktree.ts` handle one repo. Group operations loop over these with rollback on failure.
- **Resolver pattern:** `resolveProjectTarget()` in `core/resolve.ts` dispatches a name to either a group or single repo, returning `{ isGroup, name, repoAliases }`. Commands use this to branch into group vs single-repo handlers.
- **Branch resolution order:** local exists → remote exists (creates tracking branch) → neither (creates new branch).
- **Path convention:** Branch directories replace `/` with `-` (e.g., `feature/login` → `feature-login`). Single-repo worktrees at `<worktreesRoot>/<repoFolderName>/<branch-dir>/`, groups at `<worktreesRoot>/<groupName>/<branch-dir>/<repoFolderName>/`.

### Session Tracking

`core/history.ts` stores worktree sessions in `~/.work/history.json`. Keyed by `target + branch`. The `tree` command calls `upsertSession()` before launching Claude; `remove` calls `removeSession()` on success. The `status` command reads history + live git info; `recent` lists sessions sorted by last access.

### Configuration

Stored at `~/.work/config.json`. Schema in `core/config.ts`:
- `worktreesRoot` — parent directory for all worktrees
- `repos` — map of alias → repo path
- `groups` — map of group name → array of repo aliases
- `copyFiles` — glob patterns for files to copy into new worktrees (e.g., local dev settings)

### Build

tsup bundles `src/bin.ts` → `dist/bin.js` as ESM with shebang. All npm dependencies are **external** (not bundled) — resolved from `node_modules` at runtime. This is important: adding a dependency requires both `npm install` and rebuild.

### Color Forcing

`bin.ts` sets `chalk.level = 1` when chalk detects level 0, because Windows `.cmd` shims don't preserve TTY detection. Respects `NO_COLOR` env var.

### Tab Completions

`completions/index.ts` provides dynamic completions via yargs' `--get-yargs-completions`. The handler receives `argv._` as `['<scriptName>', ...args, '<current>']` — skip first and last to get completed args. For groups, branch completions read from the group's directory on disk (not individual repo worktree lists).

`core/setup-completions.ts` handles auto-installing completion lines into shell profiles. Called during `work2 init` and available standalone via `work2 completion --install`. Detects PowerShell 7/5.1 on Windows (via `[Environment]::GetFolderPath('MyDocuments')`) and bash/zsh on Unix (via `$SHELL`). Idempotent — uses a `# work2 tab completions` marker to skip if already present.
