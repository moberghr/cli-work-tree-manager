# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A cross-platform TypeScript CLI (`work`) for managing git worktrees across multiple repositories. Supports single-repo and multi-repo "group" worktrees with automatic Claude Code launching. Installed globally via `npm link`.

## Development

```bash
npm run build          # Bundle with tsup → dist/bin.js
npm run dev            # Run directly via tsx (no build needed)
npm test               # Run all tests with vitest
npm run test:watch     # Watch mode
npx vitest run tests/core/resolve.test.ts  # Single test file
```

After building, `work` is available globally (via `npm link`). Rebuild after source changes.

## CLI Commands

```
work init                                          # Interactive first-time setup
work tree|t <target> <branch> [--base <branch>] [--open] [--unsafe] [--prompt "..."] [--prompt-file <path>]  # Create/switch to worktree
work remove <target> <branch> [--force]            # Remove worktree
work list [target]                                 # List worktrees
work status [target] [branch] [--prune]            # Show worktree status
work recent [count]                                # List recent sessions
work resume [--unsafe]                             # Resume a recent session
work dash [--unsafe]                               # Interactive session dashboard (TUI)
work prune [--force]                               # Remove merged worktrees
work completion [--install]                        # Shell completions

work todo                                          # List open tasks
work todo add <text>                               # Add a task
work todo done <id>                                # Mark task complete
work todo undo <id>                                # Mark task incomplete
work todo edit <id> <text>                         # Edit task text
work todo rm <id>                                  # Remove a task
work todo --all                                    # Show completed tasks too

work config add <alias> <path>                     # Add a repository
work config remove <alias>                         # Remove a repository
work config list                                   # List repos and groups
work config group add <name> <alias1> <alias2> ... # Create a group
work config group remove <name>                    # Remove a group
work config group regen <name>                     # Regenerate group CLAUDE.md
work config show                                   # Show raw config JSON
work config edit                                   # Open config in editor

wd                                                 # Render the current diff to ~/.work/diffs/<scope-hash>.html and open it
wd <base>                                          # Diff vs an explicit ref
wd --branch                                        # PR-style diff vs the worktree's parent branch
wd --watch                                         # Background watcher: rewrites the file on every save (F5 to refresh)
wd --stop                                          # Stop the background watcher for this scope
wd -c                                              # Interactive review: comments stream to stdout, blocks until "End review"
wd --side / --no-side                              # Side-by-side (default) or unified layout
wd --theme light|dark|auto                         # Color scheme (default: light)
```

## Architecture

### Module Flow

```
bin.ts    → cli.ts (yargs router) → commands/{tree,remove,list,status,recent,prune,dash,config,init,todo,diff}.ts
wd-bin.ts → forwards argv to the `diff` command (the `wd` shim binary)
                                       ↓
                                  core/worktree.ts (atomic + high-level operations)
                                  ├── core/git.ts (git wrapper)
                                  ├── core/copy-files.ts (glob-based file copying)
                                  ├── core/resolve.ts (group vs repo dispatch)
                                  ├── core/history.ts (session tracking)
                                  ├── core/tasks.ts (local task/todo persistence)
                                  ├── core/pr.ts (GitHub PR fetching via gh CLI)
                                  ├── core/jira.ts (Jira issue fetching via acli)
                                  ├── core/setup-completions.ts (shell profile detection & install)
                                  │
                                  core/diff-*.ts (the `wd` diff + review feature)
                                  ├── diff-parse.ts (unified-diff parser → ParsedFile[])
                                  ├── diff-pipeline.ts (computeDiff: git diff + synthetic untracked)
                                  ├── diff-html.ts (HTML renderer: tabs, sidebar tree, side-by-side)
                                  ├── diff-html-scripts.ts (browser CSS + JS strings)
                                  ├── diff-watcher.ts (chokidar-driven file watcher)
                                  └── comment-server.ts (review-mode HTTP + SSE server)
                                  │
                                  tui-ink/ (Ink/React TUI for `work dash`)
                                  ├── App.tsx (main layout, keyboard handling, session management)
                                  ├── Sidebar.tsx (session list, PR pane, bordered pane components)
                                  ├── TerminalPane.tsx (renders xterm content to terminal)
                                  ├── StatusBar.tsx (keybinding hints)
                                  ├── renderer-lines.ts (line-based terminal rendering)
                                  └── index.tsx (Ink entry point)
                                  │
                                  tui/ (PTY and hook infrastructure)
                                  ├── session.ts (PtySession — node-pty + @xterm/headless)
                                  └── hooks.ts (HookServer — receives Claude Code lifecycle events)
```

### Key Design

- **Shared core operations:** `setupWorktree()` and `teardownWorktree()` in `core/worktree.ts` are the high-level entry points used by both the CLI commands and the TUI. They resolve targets, create/remove worktrees, handle group CLAUDE.md, and manage sessions. Low-level building blocks are `createSingleWorktree()` and `removeSingleWorktree()` which handle one repo with rollback on failure.
- **Resolver pattern:** `resolveProjectTarget()` in `core/resolve.ts` dispatches a name to either a group or single repo, returning `{ isGroup, name, repoAliases }`. Commands use this to branch into group vs single-repo handlers.
- **Branch resolution order:** local exists → remote exists (creates tracking branch) → neither (creates new branch).
- **Path convention:** Branch directories replace `/` with `-` (e.g., `feature/login` → `feature-login`). Single-repo worktrees at `<worktreesRoot>/<repoFolderName>/<branch-dir>/`, groups at `<worktreesRoot>/<groupName>/<branch-dir>/<repoFolderName>/`.

### TUI Dashboard (`work dash`)

An interactive terminal UI built with Ink (React for CLI). Features a sidebar listing all worktree sessions and an embedded terminal pane showing the selected session's Claude Code instance.

- **Embedded PTY sessions:** `tui/session.ts` wraps `node-pty` + `@xterm/headless` to spawn and manage Claude Code processes per worktree.
- **Hook server:** `tui/hooks.ts` runs a local HTTP server that receives Claude Code lifecycle events (Stop, Notification, UserPromptSubmit) to track session idle/active status. Hooks are injected into `~/.claude/settings.json` on startup and cleaned up on exit.
- **Ink components:** `tui-ink/App.tsx` orchestrates layout and keyboard input. `Sidebar.tsx` shows sessions with status indicators (running/idle/stopped) and a separate PR pane. `TerminalPane.tsx` renders the xterm buffer. `StatusBar.tsx` shows available keybindings.
- **5-pane layout:** The left column is split into sessions (top), PRs, Jira, and Tasks (bottom). The right side is an embedded terminal. Each pane has a title and independent focus/cursor. Tab cycles focus in visual order: sessions → PRs → Jira → Tasks → terminal. All panes support scrolling when content overflows.
- **GitHub PR integration:** `core/pr.ts` fetches open PRs via `gh pr list` for all configured repos. Shows check status (✓/✗/●), merge conflict detection, personal review state (✔/✎), draft status (dimmed), and ownership (★). Selecting a PR in the PR pane creates/resumes a worktree for that branch.
- **Jira integration:** `core/jira.ts` fetches issues assigned to the current user via `acli` (Atlassian CLI). Issues are grouped by status. Selecting a Jira issue prompts project selection, generates a branch slug (via Claude haiku), creates a worktree via `work tree` in a PTY, and sends a structured planning prompt to Claude Code via `--prompt-file`.
- **New worktree creation:** Users can create new worktrees directly from the dashboard via a project/branch picker flow, from a PR, from a Jira issue, or from a task (`w` key creates a `todo/<slug>` branch).
- **Tasks pane:** Shows local tasks from `~/.work/tasks.json`. Supports add (`a`), edit (`e`), toggle done (`enter`/`x`), remove (`d`), and create worktree (`w`). File-watched for reactive updates from external changes.
- **Reactive session detection:** Uses `fs.watch` on `history.json` to detect new sessions created externally (e.g., `work tree` in another terminal).
- **Auto-sync:** On startup, all repo remotes are fetched in parallel and PR/Jira data is loaded.
- **Context-sensitive status bar:** Shows different keybinding hints depending on which pane is focused.

### Session Tracking

`core/history.ts` stores worktree sessions in `~/.work/history.json`. Keyed by `target + branch`. The `tree` command calls `upsertSession()` before launching Claude; `remove` calls `removeSession()` on success. The `status` command reads history + live git info; `recent` lists sessions sorted by last access.

### Diff Review (`wd`)

Second binary (`dist/wd-bin.js`, shim `wd`) that surfaces a GitHub-PR-style diff in the browser. Three modes share a stable per-scope file at `~/.work/diffs/<sha1-of-sorted-roots>.html`:

- **One-shot (`wd`):** `computeDiff` (git diff + synthesized unified-diff blocks for untracked files — no index mutation) → `renderDiffHtml` → write file → `openUrl`. Static page.
- **Watcher (`wd --watch`):** spawns a detached daemon (via `spawnDaemon`) that runs `startDiffWatcher` from `diff-watcher.ts`. chokidar watches every repo root, debounced 150ms, `.git/` filtered. Per-repo dirty tracking — only changed repos are recomputed. Browser is plain `file://`; user F5s after edits. PID file at `<scope-hash>.pid`, daemon log at `<scope-hash>.log`.
- **Review (`wd -c`):** foreground HTTP server via `startCommentServer` in `comment-server.ts`. Serves the HTML at `/`, accepts `POST /api/comments` (and `DELETE /api/comments/:id`), `POST /api/done` (resolves the blocking promise), and `GET /events` (SSE for live reload). Embedded chokidar watcher pushes reload events on file changes. Live URL written to `~/.work/diffs/latest-review.url` so external tools (e.g. Claude via curl) can post replies. Streams each comment as `--- comment ---` markdown chunks to stdout — see `formatSingleComment`. Comments carry `author` (`user`/`claude`) + `parentId` for threading; the renderer styles claude replies distinctly.

**Scope resolution** (`resolveScope` in `commands/diff.ts`): walks the cwd against the session history. Inside a single-repo worktree → that repo. Inside any sub-repo of a group worktree → the whole group, with that sub-repo as the initially-active tab. At a group root → all repos, no active tab preselected. Outside any work-managed worktree → falls back to `git rev-parse --show-toplevel` (single repo).

**Renderer (`diff-html.ts`):** per-repo `<section>` with its own sidebar (tree, filter, scrollspy) and `<main>`. Tab bar at top in multi-repo mode. Slugs deduped so two sub-repos with the same basename get unique tab IDs. Syntax highlighting via highlight.js CDN, scoped per-cell. `diff-html-scripts.ts` carries the embedded browser CSS + JS as plain template-string exports.

**Status output convention:** stdout carries data only (the comments markdown payload in review mode). All status messages go to stderr via the `info()` helper in `commands/diff.ts`. `console.error` is reserved for real errors.

**Claude integration:** the `wd-review` skill at `.claude/skills/wd-review/SKILL.md` (mirrored into `~/.claude/skills/` for user-level invocation) drives a full review loop — runs `wd -c` in background, tails the marker stream via Monitor, reacts to each comment, posts threaded replies via curl using `~/.work/diffs/latest-review.url`. Replies must use `--data-binary "@file"` not inline `-d '...'` to survive apostrophes in the body.

### Configuration

Stored at `~/.work/config.json`. Schema in `core/config.ts`:
- `worktreesRoot` — parent directory for all worktrees
- `repos` — map of alias → repo path
- `groups` — map of group name → array of repo aliases
- `copyFiles` — glob patterns for files to copy into new worktrees (e.g., local dev settings)

### Build

tsup bundles two entry points: `src/bin.ts` → `dist/bin.js` (the `work` binary) and `src/wd-bin.ts` → `dist/wd-bin.js` (the `wd` shim that forwards argv to the `diff` subcommand). Both ship as ESM with shebangs. All npm dependencies are **external** (not bundled) — resolved from `node_modules` at runtime. This is important: adding a dependency requires both `npm install` and rebuild. `package.json` declares both binaries under `"bin"` so `npm link` registers `work` and `wd` globally.

### Color Forcing

`bin.ts` sets `chalk.level = 1` when chalk detects level 0, because Windows `.cmd` shims don't preserve TTY detection. Respects `NO_COLOR` env var.

### Tab Completions

`completions/index.ts` provides dynamic completions via yargs' `--get-yargs-completions`. The handler receives `argv._` as `['<scriptName>', ...args, '<current>']` — skip first and last to get completed args. For groups, branch completions read from the group's directory on disk (not individual repo worktree lists).

`core/setup-completions.ts` handles auto-installing completion lines into shell profiles. Called during `work init` and available standalone via `work completion --install`. Detects PowerShell 7/5.1 on Windows (via `[Environment]::GetFolderPath('MyDocuments')`) and bash/zsh on Unix (via `$SHELL`). Idempotent — uses a `# work tab completions` marker to skip if already present.
