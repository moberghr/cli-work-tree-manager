<div align="center">

# Work — Git Worktree Manager for AI-Assisted Development

### One terminal. Every branch. Every repo. Every Claude session.

**A cross-platform TypeScript CLI that turns git worktrees into a parallel-development cockpit. Spin up isolated workspaces per branch across one or many repos, auto-launch Claude Code, and orchestrate everything — PRs, Jira issues, and local tasks — from a single interactive dashboard.**

[![Version](https://img.shields.io/badge/version-1.3.0-blue.svg)](https://github.com/moberghr/cli-work-tree-manager/releases)
[![Website](https://img.shields.io/badge/website-moberghr.github.io-6d28d9.svg)](https://moberghr.github.io/cli-work-tree-manager/)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[moberghr.github.io/cli-work-tree-manager](https://moberghr.github.io/cli-work-tree-manager/)** — the Work website.

[Quick Start](#quick-start) · [Why Work](#why-work) · [Commands](#commands) · [Dashboard](#interactive-dashboard) · [Groups](#groups-multi-repo-worktrees) · [Diff review (`wd`)](#diff-review-wd) · [Architecture](#architecture) · [FAQ](#faq)

</div>

---

## Why Work

Working on three branches in three repos with three Claude Code instances is a productivity superpower — *if* you can keep the cognitive overhead under control. Without tooling, you end up juggling terminals, losing track of which session is in which directory, and rebuilding mental context every time you switch.

Work is the missing layer between `git worktree` and your AI assistant. Every branch gets a real, isolated checkout. Every checkout gets its own Claude Code session, persisted across resumes. Every session is visible — alongside its PR status, assigned Jira issues, and pending tasks — in a single dashboard.

| Without Work | With Work |
|:---|:---|
| `cd ../some/path && git checkout -b feature/x && cp .env.local .` every time | `work tree api feature/x` — worktree created, dev settings copied, Claude launched |
| Three terminals, three editors, three lost contexts | One TUI: sessions, PRs, Jira, tasks — keyboard-driven, mouse-aware |
| "Which directory was that branch in again?" | `work resume` — recent sessions sorted by last access, one keystroke to re-enter |
| Multi-repo features = multiple `git worktree add` invocations and a hand-merged CLAUDE.md | `work tree mygroup feature/x` — every repo cloned in lockstep, combined CLAUDE.md generated automatically |
| Stale worktrees pile up after PRs merge | `work prune` — removes worktrees whose branches landed on main |
| Jira ticket → branch name → worktree → Claude prompt = manual every time | Select a Jira issue in the dash → branch slug auto-generated → worktree created → planning prompt sent to Claude |

---

## Quick Start

```bash
# 1. Install (Node 18+, Git required)
git clone https://github.com/moberghr/cli-work-tree-manager work
cd work
npm install
npm run build
npm link

# 2. First-time setup — interactive
work init

# 3. Create a worktree and launch Claude Code
work tree api feature/login

# 4. Open the dashboard
work dash
```

`work init` walks you through the worktrees root, your repo aliases, and tab-completion installation. Everything else is one keystroke away from the dashboard.

### Prerequisites

| Tool | Required | Used for |
|:---|:---|:---|
| **Node.js 18+** | yes | Runtime |
| **Git** | yes | Worktree operations |
| **[Claude Code CLI](https://claude.ai/code)** | recommended | Auto-launch on `work tree`, group CLAUDE.md generation |
| **[GitHub CLI (`gh`)](https://cli.github.com/)** | optional | PR pane in dashboard |
| **[Atlassian CLI (`acli`)](https://developer.atlassian.com/cloud/acli/)** | optional | Jira pane in dashboard |

---

## Commands

```
work init                                              # Interactive first-time setup
work tree|t <target> <branch> [flags]                  # Create or switch to a worktree
work remove <target> <branch> [--force]                # Remove a worktree
work list [target]                                     # List worktrees
work status [target] [branch] [--prune]                # Show worktree merge/dirty status
work recent [count]                                    # List recent sessions
work resume [--unsafe]                                 # Resume a recent session
work dash [--unsafe]                                   # Interactive TUI dashboard
work prune [--force]                                   # Remove merged worktrees
work completion [--install]                            # Shell completions

work todo                                              # List open tasks
work todo add|done|undo|edit|rm <args>                 # Manage tasks
work todo --all                                        # Include completed tasks

work config add|remove|list|show|edit                  # Manage repos
work config group add|remove|regen <args>              # Manage multi-repo groups

wd                                                     # PR-style diff in your browser (one-shot)
wd --watch                                             # Background watcher; F5 to refresh
wd --stop                                              # Stop the running watcher
wd -c                                                  # Interactive review with streaming comments
```

`work tree` flags: `--base <branch>` (branch from a specific base), `--open` (open VS Code), `--unsafe` (skip Claude permission checks), `--prompt "..."` / `--prompt-file <path>` (send an initial prompt to Claude).

### Branch resolution order

When you run `work tree api feature/login`:

1. **Local branch exists** → checked out into the worktree
2. **Remote branch exists** → fetched and checked out as a tracking branch
3. **Neither** → a new branch is created from the configured base (or `--base`)

Branch directories normalize `/` → `-`, so `feature/login` lives at `<worktreesRoot>/<repo>/feature-login/`.

---

## Interactive Dashboard

```bash
work dash
```

A keyboard-driven terminal UI built with [Ink](https://github.com/vadimdemedes/ink) and an embedded `node-pty` + `@xterm/headless` Claude Code session per worktree. Five panes, one focus model, zero context switching.

```
┌──────────────────────────────┬─────────────────────────────────────────────────┐
│ Sessions                  ▸  │  api · feature/login                            │
│   ▸ api · feature/login   ●  │                                                 │
│     api · main               │  > Implement the login page using the existing  │
│     web · feat/dark-mode  ●  │    auth helpers...                              │
│ ──────────────────────────── │                                                 │
│ Pull Requests                │  ✓ Reading src/auth/AuthContext.tsx             │
│   ★ #142 · feature/login  ✓  │  ✓ Writing src/pages/login.tsx                  │
│   ✎ #138 · feat/dark-mode ✗  │  ✓ dotnet build (0 warnings, 0 errors)          │
│ ──────────────────────────── │                                                 │
│ Jira                         │  ⏵                                              │
│   In Progress                │                                                 │
│     PROJ-204 · Add 2FA       │                                                 │
│ ──────────────────────────── │                                                 │
│ Tasks                        │                                                 │
│   [ ] Refactor auth module   │                                                 │
│   [x] Document new endpoints │                                                 │
└──────────────────────────────┴─────────────────────────────────────────────────┘
 tab cycles · n new · d remove · g sync pane · G sync all · enter open · w worktree
```

### What the dashboard does

- **Session pane** — every worktree as a row with a status indicator (`●` running, `○` idle, `▸` currently focused). Reactive to external `work tree` invocations via `fs.watch` on `history.json`.
- **PR pane** — open PRs across every configured repo via `gh pr list`. Decorated with check status (`✓` / `✗` / `●`), merge-conflict detection, your review state (`✔` approved, `✎` reviewed), draft dimming, and ownership (`★` your PR). Selecting a PR creates or resumes its worktree.
- **Jira pane** — issues assigned to you, grouped by status, fetched via `acli`. Selecting an issue prompts for project, generates a branch slug via Claude Haiku, creates the worktree, and sends a structured planning prompt to Claude. `o` opens the issue in your browser.
- **Tasks pane** — local tasks from `~/.work/tasks.json`. Press `a` to add, `e` to edit, `enter`/`x` to toggle, `d` to remove, `w` to spin up a `todo/<slug>` worktree.
- **Terminal pane** — the live Claude Code PTY for the focused session. Resumes prior conversations via `--continue`. Mouse scroll, Shift+drag for text selection.
- **Auto-sync on startup** — every repo remote fetched in parallel; PRs and Jira issues loaded immediately. `g` syncs the focused pane, `G` syncs everything.
- **Hook integration** — a local HTTP server (`tui/hooks.ts`) receives Claude Code lifecycle events (Stop, Notification, UserPromptSubmit) so session activity is reflected in real time. Hooks are auto-injected into `~/.claude/settings.json` on launch and cleaned up on exit.
- **Context-sensitive status bar** — keybinding hints change based on the focused pane.

### Keyboard reference

| Key | Action |
|:---|:---|
| `tab` | Cycle focus: sessions → PRs → Jira → tasks → terminal |
| `j` / `k` | Navigate within the focused pane |
| `enter` | Open / resume the selected item |
| `n` | New worktree (project + branch picker) |
| `d` | Remove the selected worktree |
| `w` | Create worktree from selected task / PR / Jira issue |
| `a` / `e` | Add or edit task (tasks pane) |
| `g` / `G` | Sync focused pane / sync everything |
| `u` | Rebase current worktree onto its base |
| `.` | Open worktree in editor |
| `o` | Open Jira issue in browser |

---

## Groups (Multi-Repo Worktrees)

When a feature spans several repositories — say a backend API change that ships with a frontend update — Work treats them as a single unit.

```bash
# Define a group
work config group add fullstack api web shared-lib

# Create one worktree workspace covering all three repos
work tree fullstack feature/new-checkout

# Combined directory layout
<worktreesRoot>/
  fullstack/
    feature-new-checkout/
      api/             # worktree for api repo
      web/             # worktree for web repo
      shared-lib/      # worktree for shared-lib repo
      CLAUDE.md        # auto-generated combined instructions

# Tear it all down at once
work remove fullstack feature/new-checkout
```

The combined `CLAUDE.md` is produced by invoking the Claude CLI to merge each repo's individual `CLAUDE.md` into a coherent multi-repo brief — so the Claude session that gets launched understands every codebase it can see. Regenerate any time with `work config group regen <name>`.

---

## Diff Review (`wd`)

A second binary, **`wd`**, ships alongside `work` and gives you a GitHub-PR-style diff view in your browser — for the current worktree, or for every repo in a group.

```bash
wd                  # one-shot: render the current uncommitted diff, open in browser
wd --watch          # background daemon: rewrites the file on every save, F5 to refresh
wd --stop           # stop the watcher for this scope
wd -c               # interactive review: leave comments inline, stream to stdout
wd main             # diff vs an explicit ref
wd --branch         # PR-style diff vs the branch this worktree was forked from
```

`wd` resolves the scope from your `cwd`: inside a single-repo worktree it diffs that repo; inside a group worktree (root or any sub-repo) it diffs every repo in the group and renders one tab per repo. Untracked files are included as synthesized "new file" diffs without touching your git index.

### Static and live modes

| Mode | What it does |
|:---|:---|
| `wd` | Renders once to `~/.work/diffs/<scope-hash>.html`, opens in your default browser. |
| `wd --watch` | Spawns a detached watcher (chokidar) that rewrites the same file on every save; per-repo dirty tracking so unchanged repos aren't recomputed. F5 in the browser to refresh. Stop with `wd --stop`. |
| `wd -c` | Foreground review server: same file plus a small HTTP server. Click any line number to drop an inline comment. Streams each comment to stdout as it's saved. Blocks until you click "End review" or Ctrl+C. |

### Interactive review (`wd -c`)

Designed to be driven by an AI assistant (or any process that wants to react to comments as they happen). When you save a comment in the browser it lands on stdout as a markdown chunk like:

```
--- comment ---
**api/src/users.ts** : line 42 (right)
id: 1df977d4...
> use the new helper here
```

Other features in review mode:

- **Live reload** via SSE — the page refreshes itself when files change; reloads are deferred while you're composing so your draft isn't lost.
- **Threaded replies** — a wrapping process can POST replies via `${URL}/api/comments` with `parentId` and `author: 'claude'`; they render inline under the original comment with distinct styling.
- **Outdated detection** — the line's raw content is captured at compose time; if the file changes underneath, the comment is dimmed with an "outdated" badge.
- **General comments** — a top-of-page composer for review notes that aren't tied to any line.
- **Sidebar comments list** — every comment for the active tab, click to scroll to it.
- **Stable file path** — `~/.work/diffs/<scope-hash>.html` — keep one tab open across `wd`, `wd --watch`, and `wd -c` invocations.

The live server URL is published to `~/.work/diffs/latest-review.url` at session start (deleted on exit) so any local tool can find it without scraping stdout. A ready-made Claude Code skill ships with the repo at `.claude/skills/wd-review/SKILL.md` — drop it into `~/.claude/skills/` and say *"review my changes with wd"* in any Claude session to drive the loop.

---

## Configuration

Stored at `~/.work/config.json`:

```json
{
  "worktreesRoot": "/Users/you/worktrees",
  "repos": {
    "api":  "/Users/you/repos/api",
    "web":  "/Users/you/repos/web"
  },
  "groups": {
    "fullstack": ["api", "web"]
  },
  "copyFiles": [
    "*.Development.json",
    "*.Local.json",
    ".claude/settings.local.json"
  ]
}
```

`copyFiles` glob patterns are copied into every new worktree — the canonical use case is local dev settings (`appsettings.Development.json`, `.env.local`, `.claude/settings.local.json`) that are gitignored but needed to run the app. Edit via `work config edit` or manage via the `work config …` subcommands.

### Session tracking

Every `work tree` invocation upserts a row into `~/.work/history.json` keyed by `target + branch`. This powers:

- **`work status`** — joins history with live `git status` to show merge state, dirty trees, unpushed commits, and last-access timestamps.
- **`work recent`** — sessions sorted by last touched.
- **`work resume`** — interactive picker; one keystroke to re-enter the worktree and continue the prior Claude conversation.
- **Dashboard reactivity** — `fs.watch` on `history.json` means a `work tree` in another terminal shows up in the running dashboard immediately.

---

## Architecture

```
bin.ts    → cli.ts (yargs router) → commands/{tree,remove,list,status,recent,prune,dash,config,init,todo,diff}.ts
wd-bin.ts → forwards argv to the `diff` command (the `wd` binary shim)
                                       │
                                       ▼
                                  core/worktree.ts          ← high-level setup / teardown
                                  ├── core/git.ts           ← git wrapper
                                  ├── core/copy-files.ts    ← glob-based file copying
                                  ├── core/resolve.ts       ← group vs single-repo dispatch
                                  ├── core/history.ts       ← session tracking
                                  ├── core/tasks.ts         ← local task persistence
                                  ├── core/pr.ts            ← GitHub PR fetching (gh)
                                  ├── core/jira.ts          ← Jira issue fetching (acli)
                                  └── core/setup-completions.ts

                                  core/diff-*.ts            ← `wd` diff + review feature
                                  ├── diff-parse.ts         ← unified-diff parser
                                  ├── diff-pipeline.ts      ← computeDiff(): git diff + synthetic untracked
                                  ├── repo-spec.ts          ← RepoSpec + stableDiffPath
                                  ├── comment-server.ts     ← HTTP + SSE server (review + read-only)
                                  └── web-static.ts         ← SPA static file handler

                                  web/src/                  ← React SPA (Vite → dist/web/)
                                  ├── apps/ReviewApp.tsx    ← single-scope view (wd / wd -c)
                                  ├── apps/DashboardApp.tsx ← multi-session view (work web)
                                  └── components/           ← Diff/, Review/, Sidebar/

                                  tui-ink/                  ← Ink/React TUI
                                  ├── App.tsx               ← layout, keyboard, session mgmt
                                  ├── Sidebar.tsx           ← session list, PR pane
                                  ├── TerminalPane.tsx      ← xterm renderer
                                  └── StatusBar.tsx

                                  tui/                      ← PTY + hook infra
                                  ├── session.ts            ← node-pty + @xterm/headless
                                  └── hooks.ts              ← Claude Code lifecycle events
```

### Design principles

| Principle | What it means |
|:---|:---|
| **Atomic worktree operations** | `setupWorktree()` and `teardownWorktree()` are the high-level entry points used by both the CLI and the TUI. Low-level `createSingleWorktree()` rolls back on partial failure. |
| **Resolver pattern** | One name (`api`, `fullstack`) is dispatched through `resolveProjectTarget()` to either a group or a single repo. Commands branch on `isGroup` once and delegate. |
| **Branch resolution priority** | Local exists → remote exists (tracking branch) → neither (new branch from base). |
| **Path normalisation** | `feature/login` → `feature-login` directory. Always. |
| **External binaries are external** | tsup bundles `src/bin.ts` as ESM with all dependencies marked `external` — they're resolved from `node_modules` at runtime. Adding a dep means `npm install` *and* rebuild. |
| **Color forcing for Windows** | `bin.ts` raises `chalk.level` to 1 when chalk detects 0 — Windows `.cmd` shims don't preserve TTY detection. `NO_COLOR` is respected. |

---

## Tab Completion

Auto-installed during `work init`. Available standalone:

```bash
work completion --install
```

Detects PowerShell 7 / 5.1 on Windows (via `[Environment]::GetFolderPath('MyDocuments')`) and bash / zsh on Unix (via `$SHELL`). Idempotent — uses a `# work tab completions` marker to skip if already present. Manual fallback:

| Shell | Add to profile |
|:---|:---|
| **PowerShell** (`$PROFILE`) | `work completion --shell powershell \| Out-String \| Invoke-Expression` |
| **Bash** (`~/.bashrc`) | `eval "$(work completion)"` |
| **Zsh** (`~/.zshrc`) | `eval "$(work completion)"` |

Completions are dynamic — branch names come from the worktree directory listing for groups, and from each repo's worktree list for single repos.

---

## Development

```bash
npm run build                                      # Bundle with tsup → dist/bin.js
npm run dev                                        # Run directly via tsx (no build)
npm test                                           # Run all tests with vitest
npm run test:watch                                 # Watch mode
npx vitest run tests/core/resolve.test.ts          # Single test file
```

After building, `work` is available globally via `npm link`. Rebuild after source changes.

### Project layout

```
work-tree/
├── src/
│   ├── bin.ts                  # Entry point (chalk forcing, shebang)
│   ├── cli.ts                  # yargs router
│   ├── commands/               # CLI command handlers
│   ├── core/                   # Shared operations (worktree, git, history, …)
│   ├── tui-ink/                # Ink/React TUI dashboard
│   ├── tui/                    # PTY sessions and hook server
│   ├── completions/            # Dynamic tab-completion handler
│   └── utils/
├── tests/                      # vitest suites
├── work.ps1                    # PowerShell shim
├── work-completions.ps1        # PowerShell completion script
├── tsup.config.ts
└── package.json
```

---

## Unsafe Mode & Debug Logging

`--unsafe` on `work tree`, `work resume`, or `work dash` passes `--dangerously-skip-permissions` to the Claude CLI — useful in trusted, sandboxed worktrees, dangerous everywhere else. Use deliberately.

All CLI output and internal debug messages stream to `~/.work/debug.log` with timestamps. Auto-rotates at 5 MB. The first place to look when worktree creation, group CLAUDE.md generation, or hook delivery misbehaves.

---

## FAQ

<details>
<summary><b>Why git worktrees instead of branches in one checkout?</b></summary>

Branches share a working directory. Worktrees give every branch its own isolated checkout — separate `node_modules`, separate `bin/obj`, separate dev-server processes, separate Claude Code sessions. You can run all of them concurrently without `git stash` gymnastics or losing your build cache.
</details>

<details>
<summary><b>Do I have to use Claude Code?</b></summary>

No — `work tree`, `work list`, `work status`, `work prune`, and the dashboard's session pane all work without Claude Code installed. You just lose auto-launch, group CLAUDE.md generation, and the embedded terminal in the dashboard. The CLI degrades gracefully when `claude` isn't on PATH.
</details>

<details>
<summary><b>Does the dashboard work on Windows?</b></summary>

Yes. Ink and node-pty support Windows; PowerShell completions are installed automatically. Mouse and keyboard handling work in Windows Terminal, ConEmu, and the new VS Code integrated terminal.
</details>

<details>
<summary><b>What happens when a worktree's branch is merged?</b></summary>

`work prune` lists every worktree whose branch is merged into `main` / `master` and offers to remove them interactively. `--force` skips the prompt. For groups, every sub-repo's branch must be merged before the group is offered.
</details>

<details>
<summary><b>Can I customize which files get copied into new worktrees?</b></summary>

Yes — edit `copyFiles` in `~/.work/config.json` (or run `work config edit`). Any glob pattern works. The default set covers `*.Development.json`, `*.Local.json`, and `.claude/settings.local.json` — the typical "gitignored but required to run" trio.
</details>

<details>
<summary><b>How does the Jira → branch flow work?</b></summary>

Pick a Jira issue in the dash, choose the target project, and Work invokes Claude Haiku with the issue title to generate a branch slug. It then runs `work tree <project> <slug>` in a PTY and pipes a structured planning prompt to Claude via `--prompt-file`. End result: a fresh worktree with Claude already thinking about your ticket.
</details>

<details>
<summary><b>Can I use my own AI assistant instead of Claude Code?</b></summary>

The auto-launch and the dashboard's embedded session both target Claude Code specifically. Other tools can still benefit from the worktree management, group CLAUDE.md generation, and session tracking — just don't pass `--prompt` flags or use the embedded terminal pane.
</details>

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

**Work — Git Worktree Manager** v1.3.0 · [Moberg d.o.o.](https://www.moberg.hr)

Built for engineers who run more than one branch at a time.

</div>
