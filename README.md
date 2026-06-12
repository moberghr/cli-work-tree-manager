<div align="center">

# Work — Git Worktree Manager for AI-Assisted Development

### One terminal. Every branch. Every repo. Every Claude session.

**A cross-platform TypeScript CLI that turns git worktrees into a parallel-development cockpit. Spin up isolated workspaces per branch across one or many repos, auto-launch Claude Code (or any AI CLI), and orchestrate everything — PRs, Jira issues, local tasks, diffs, and reviews — from a terminal dashboard or a single browser tab.**

[![Version](https://img.shields.io/badge/version-1.5.0-blue.svg)](https://github.com/moberghr/cli-work-tree-manager/releases)
[![Website](https://img.shields.io/badge/website-moberghr.github.io-6d28d9.svg)](https://moberghr.github.io/cli-work-tree-manager/)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[moberghr.github.io/cli-work-tree-manager](https://moberghr.github.io/cli-work-tree-manager/)** — the Work website.

[Quick Start](#quick-start) · [Why Work](#why-work) · [Commands](#commands) · [Dashboard](#interactive-dashboard) · [Browser (`work web`)](#browser-dashboard-work-web) · [Fleet](#fleet-commands-run--broadcast) · [Groups](#groups-multi-repo-worktrees) · [Diff review (`wd`)](#diff-review-wd) · [Architecture](#architecture) · [FAQ](#faq)

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
| Stale worktrees pile up after PRs merge | `work prune` (interactive) / `work sync` (one-shot) — remove worktrees whose branches landed on main |
| Jira ticket → branch name → worktree → Claude prompt = manual every time | Select a Jira issue in the dash → branch slug auto-generated → worktree created → planning prompt sent to Claude |
| Same chore (`npm test`, rebase) in five worktrees, one terminal at a time | `work run --all npm test` / `work broadcast --all "rebase onto main"` — fan out across the fleet |
| Diffs and reviews scattered across terminals and editor tabs | `wd` / `work web` — every diff and review in one browser, comments routed back to the live AI session |

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

# 3. Create a worktree and launch your AI tool
work tree api feature/login

# 4. Open the dashboard (terminal TUI, or `work web` for the browser)
work dash
```

`work init` walks you through the worktrees root, your repo aliases, your AI command, and tab-completion installation. Everything else is one keystroke away from the dashboard.

### Prerequisites

| Tool | Required | Used for |
|:---|:---|:---|
| **Node.js 18+** | yes | Runtime |
| **Git** | yes | Worktree operations |
| **[Claude Code CLI](https://claude.ai/code)** | recommended | Default AI tool auto-launched on `work tree`; group CLAUDE.md generation. Any other CLI works too — set `aiCommand` in config. |
| **[GitHub CLI (`gh`)](https://cli.github.com/)** | optional | PR pane in the dashboard / `work web` |
| **[Atlassian CLI (`acli`)](https://developer.atlassian.com/cloud/acli/)** | optional | Jira pane in the dashboard / `work web` |

---

## Commands

```
work init                                              # Interactive first-time setup
work tree|t <target> <branch> [flags]                  # Create or switch to a worktree
work tree --here                                       # Infer target+branch from the current worktree
work remove <target> <branch> [--force]                # Remove a worktree
work list [target]                                     # List worktrees
work status [target] [branch] [--prune]                # Show worktree merge/dirty status
work recent [count]                                    # List recent sessions
work resume [--unsafe]                                 # Resume a recent session
work dash [--unsafe]                                   # Interactive TUI dashboard
work web [--stop] [--no-open]                          # Browser dashboard (singleton; all sessions in one tab)
work prune [--force]                                   # Remove merged worktrees (interactive)
work sync [--dry-run] [--force] [--include-squash]     # Fetch all repos + prune merged worktrees (non-interactive)
work completion [--install]                            # Shell completions

work run <cmd...> [--target <a>] [--all] [--parallel]  # Run a shell command across worktrees
work broadcast <prompt> [--target <a>] [--all]         # Queue a prompt to every live AI session

work todo                                              # List open tasks
work todo add|done|undo|edit|rm <args>                 # Manage tasks
work todo --all                                        # Include completed tasks

work config add|remove|list|show|edit                  # Manage repos
work config group add|remove|regen <args>              # Manage multi-repo groups

wd                                                     # PR-style diff in your browser (live server)
wd --branch                                            # Open the "Since branch" tab by default
wd --static                                            # Self-contained HTML file (no server)
wd --stop                                              # Stop the background server for this scope
wd -c                                                  # Interactive review with streaming comments
```

`work tree` flags: `--here` (infer target+branch from cwd), `--base <branch>` (branch from a specific base), `--open` (open the configured editor), `--unsafe` (skip AI-tool permission checks), `--prompt "..."` / `--prompt-file <path>` (send an initial prompt), `--jira-key <KEY>` (link a Jira issue to the session), `--setup-only` (create the worktree without launching the AI tool).

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

## Browser Dashboard (`work web`)

Prefer a browser to the terminal? `work web` brings the dashboard — every session, its diff, its review comments, and a live terminal — into a single tab.

```bash
work web                # start (or re-attach to) the dashboard, opens the browser
work web --no-open      # start without opening a browser
work web --stop         # shut the dashboard down
```

- **Singleton** — one process per user, tracked by `~/.work/web.pid` + `~/.work/web.url`. A second `work web` re-uses the running one instead of spawning a duplicate; the port is chosen deterministically from the configured `portRange` (default `3000–3099`) with a liveness probe so it survives restarts and avoids collisions.
- **Every session in one place** — the sidebar lists all worktree sessions with activity badges (active / idle / stale) and per-session comment/draft counts, reactive to `work tree` / `work remove` anywhere on the machine.
- **Per-session tabs** — a **Diff** tab (Uncommitted vs HEAD, plus "Since branch"), a **Comments** review tab, and a live **Terminal** tab (a `node-pty` Claude session, same as the TUI).
- **Top panes** — PRs (via `gh`), Jira (via `acli`), and Tasks — with create / sync / rebase / open-in-editor actions wired to `POST /api/worktrees` and friends.
- **One server, every `wd` scope** — every `wd` and `wd -c` invocation registers as a *scope* on this server (addressable at `/diff/<hash>` and `/review/<hash>`) instead of spawning its own port. A dozen reviews share one process and one set of tabs.
- **Hook bridge to live Claude** — on startup `work web` installs `UserPromptSubmit` and `Stop` command hooks in `~/.claude/settings.json` (removed on shutdown). Drop a comment on a line and any Claude running in that worktree picks it up on its next turn — no copy-paste.

---

## Fleet Commands (`run` / `broadcast`)

Once you have several worktrees open, you often want to do *one thing* to *all of them*. Two commands fan out across the fleet.

### `work run` — a command in every worktree

```bash
work run npm test                       # run in EVERY worktree (requires --all)
work run --all npm test                 # explicit confirmation for the whole fleet
work run --target api npm run build     # only worktrees for the `api` alias
work run --target api --branch feat/x … # narrow to a single branch
work run --all --parallel --jobs 6 …    # run concurrently, up to 6 at a time
work run --all --halt-on-error npm test # sequential: stop after the first failure
```

- **Blast-radius guardrail** — a bare `work run <cmd>` with no `--target` refuses to run until you pass `--all`. Narrow with `--target <alias>` (and optionally `--branch`).
- **Sequential by default** — output streams through transparently. With `--parallel`, output is captured and re-emitted line-by-line with a `[target/branch]` prefix so concurrent logs stay attributable; `--jobs` (default 4) caps concurrency with a worker pool.
- **Ctrl-C tears the whole fleet down** — in-flight children are killed and the pool stops dequeuing rather than orphaning subprocesses. Exit code is non-zero if any worktree failed.
- The command runs through `sh -c` (POSIX) / `cmd.exe /c` (Windows); your command string is the intentional payload — Work never interpolates paths or branch names into a shell string itself.

### `work broadcast` — a prompt to every live AI session

```bash
work broadcast --all "rebase onto main and resolve conflicts"
work broadcast --target api "run the test suite and fix failures"
echo "long prompt…" | work broadcast --all -      # read the prompt from stdin
```

`broadcast` queues your prompt to each matching session and the session picks it up on its **next turn** via the same `UserPromptSubmit` hook `work web` uses — so it works even when you're not looking at that terminal. The same `--all` guardrail applies: broadcasting to every session requires an explicit `--all` or a narrowing `--target`. Delivery is lazy and crash-safe — the prompt is written to each session's comment store under a file lock, so a concurrent `work web` write can't clobber it.

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
wd                  # live diff server: renders the current diff, refresh to see edits
wd --branch         # open the "Since branch" tab by default (PR-style vs the parent branch)
wd main             # diff vs an explicit ref
wd --static         # write a self-contained HTML file (no server, survives the CLI)
wd --stop           # stop the background server for this scope
wd -c               # interactive review: leave comments inline, stream to stdout
```

`wd` resolves the scope from your `cwd`: inside a single-repo worktree it diffs that repo; inside a group worktree (root or any sub-repo) it diffs every repo in the group and renders one tab per repo. Untracked files are included as synthesized "new file" diffs without touching your git index.

**One server, every scope.** `wd` and `wd -c` register as a *scope* on the singleton `work web` and open `/diff/<hash>` or `/review/<hash>` — no new process, no extra port. When no `work web` is running, `wd` auto-starts a lean one in the background (`work web --lean --no-open`) and registers on that. Either way the live page reloads itself over SSE when files change.

### Modes

| Mode | What it does |
|:---|:---|
| `wd` (default) | **Live server.** Registers on a running `work web`, or auto-starts a lean one in the background. Refresh the browser to pick up saved-file changes (chokidar + SSE, per-repo dirty tracking). De-register this scope with `wd --stop`. `--server` / `--watch` are kept as back-compat aliases. |
| `wd --static` | Renders a fully self-contained HTML file to `~/.work/diffs/<scope-hash>.html` (bundle + diff JSON inlined), opens via `file://`, and exits. No server, no live reload — survives the CLI. |
| `wd -c` | **Interactive review.** Click any line number to drop an inline comment; each comment streams to stdout as a markdown marker as it's saved. Blocks until you click "Done & Send" (or Ctrl+C). |

### Reading the diff

- **Uncommitted vs Since branch** — toggle between the working-tree diff and the full PR-style diff against the branch this worktree was forked from.
- **Checkpoints + range diff** — `wd` snapshots each repo's working tree (including untracked files) and holds the snapshots alive behind `refs/wd/<scope>/<n>` refs. Snapshots are taken **per Claude turn** (via the Stop hook) and when edits settle, so each one is a meaningful unit of work rather than one-per-save. A **Range** picker — a single `From → To` dropdown with a pinned *All changes* reset — lets you diff any two points: the full diff, a single checkpoint's own changes (click it), or any span (shift-click to widen the start). Each checkpoint is labelled with a one-line **Claude-generated summary** of what it changed (generated lazily, cached in the manifest), so you pick by meaning, not by number.
- **Coverage badges** — if a `coverage/lcov.info` (or `lcov.info`) is present, each file shows its line-coverage percentage. The badge is de-emphasized and flagged when the source has been edited since the coverage report was written, so you don't trust stale numbers.
- **Reviewed-hunk checkboxes** — tick individual hunks as you review them. The state is keyed on a content hash of the hunk (not line numbers), so it survives live reloads and unrelated edits elsewhere in the file, and persists per-scope in `localStorage`.
- **Expand context** — each hunk separator is a GitHub-style bar showing the `@@ … @@` heading; where lines are collapsed, converging `↓` / `↑` controls on it reveal the hidden lines a chunk at a time (or all the way to the top/bottom of the file). When a gap is fully expanded — or two hunks are already adjacent — the lines become contiguous and the separator drops away.
- **Open whole file** — each file header has an *"Open file ↗"* link that opens the full working-tree file, syntax-highlighted and read-only, in a new tab. (Hidden for deleted/binary files and in `--static` mode, which has no server to read from.)
- **Word-level intra-line diff**, npm-bundled syntax highlighting, auto-collapsed large/migration files, and a file-tree sidebar with per-file viewed checkboxes.

### Interactive review (`wd -c`)

Designed to be driven by an AI assistant (or any process that wants to react to comments as they happen). When you save a comment in the browser it lands on stdout as a markdown chunk like:

```
--- comment ---
**api/src/users.ts** : line 42 (right)
id: 1df977d4...
> use the new helper here
```

Other features in review mode:

- **Markdown comments** — both your comments and Claude's replies render as formatted markdown (code blocks, lists, links), not raw text.
- **Live reload** via SSE — the page refreshes itself when files change; reloads are deferred while you're composing so your draft isn't lost.
- **Threaded replies** — a wrapping process posts replies with `parentId` and `author: 'claude'`. In the normal (work-web) flow that's `POST <web>/api/scopes/<hash>/comments`, where `<hash>` is the segment from the `/review/<hash>` URL; the standalone fallback is `POST <url>/api/comments`. Replies render inline under the original with distinct styling.
- **Resolve / mark done** — mark a comment thread resolved: it collapses to a one-line bar in the diff (click to reopen), and stays listed but dimmed + struck-through in the comments panel, so you can fold away what's handled without losing the record.
- **Whole-file comments** — a *Comment on file* button in each file header attaches a comment to the file as a whole (GitHub-style), not a specific line.
- **Drafts & submit** — stage multiple comments as drafts, then submit them in one batch (GitHub-style).
- **Outdated detection** — the line's raw content is captured at compose time; if the file changes underneath, the comment is dimmed with an "outdated" badge.
- **General comments** — a top-of-page composer for review notes that aren't tied to any line.
- **Stable scope hash** — keep one tab open across repeated `wd` / `wd -c` invocations for the same worktree.

When running standalone (no `work web`), the live URL is published to `~/.work/diffs/latest-review.url` so any local tool can find it without scraping stdout. A ready-made Claude Code skill ships as the `work-tree` plugin (`plugins/work-tree/skills/wd-review/SKILL.md`) — installing the npm package auto-registers the plugin marketplace and installs the plugin when the `claude` CLI is present. To add it manually: `claude plugin marketplace add moberghr/cli-work-tree-manager && claude plugin install work-tree@work-tree`. Then say *"review my changes with wd"* in any Claude session to drive the loop.

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
  ],
  "aiCommand": "claude",
  "editor": "code",
  "portRange": { "start": 3000, "end": 3099 },
  "notifications": false,
  "statusHooks": [
    { "on": "needs_input", "command": "afplay /System/Library/Sounds/Glass.aiff" }
  ]
}
```

| Key | Purpose |
|:---|:---|
| `worktreesRoot` | Parent directory for every worktree. |
| `repos` | Alias → repo path. |
| `groups` | Group name → list of repo aliases. |
| `copyFiles` | Glob patterns copied into every new worktree — the canonical use is local dev settings (`appsettings.Development.json`, `.env.local`, `.claude/settings.local.json`) that are gitignored but needed to run the app. |
| `aiCommand` | The AI CLI to auto-launch (default `claude`). Set it to any other tool; per-tool flag names live under `aiCommandFlags`. |
| `editor` | Editor command for `--open` / "open in editor" (default `code`). |
| `portRange` | Port window `work web` allocates from (default `3000`–`3099`). |
| `notifications` | Opt-in desktop notification when a session goes idle or needs input. |
| `statusHooks` | Run your own shell command on a session status change — see below. |

Edit via `work config edit`, or manage repos/groups via the `work config …` subcommands.

### Notifications & status hooks

When a background AI session finishes its turn (`idle`) or blocks waiting on you (`needs_input`), Work can let you know:

- **`notifications: true`** — fires a native desktop notification (macOS `osascript`, Linux `notify-send`, Windows BurntToast/balloon best-effort). Repeated alerts within one idle period are de-duplicated; submitting a new prompt re-arms it.
- **`statusHooks`** — the general form. Each entry is `{ "on": "idle" | "needs_input", "command": "..." }`. The command runs (with the session directory as cwd) on that transition, with `WORK_SESSION` and `WORK_STATUS` in its environment — use it for sounds, Slack pings, or anything scriptable.

### Session tracking

Every `work tree` invocation upserts a row into `~/.work/history.json` keyed by `target + branch`. This powers:

- **`work status`** — joins history with live `git status` to show merge state, dirty trees, unpushed commits, and last-access timestamps.
- **`work recent`** — sessions sorted by last touched.
- **`work resume`** — interactive picker; one keystroke to re-enter the worktree and continue the prior AI conversation.
- **`work prune` / `work sync`** — `prune` interactively removes worktrees whose branches landed on `main`/`master`; `work sync` does the same non-interactively after fetching every repo in parallel (`--dry-run` to preview, `--force` to include dirty/unpushed trees, `--include-squash` to also catch squash-merged branches).
- **Dashboard reactivity** — `fs.watch` on `history.json` means a `work tree` in another terminal shows up in the running dashboard (TUI and `work web`) immediately.

---

## Architecture

```
bin.ts    → cli.ts (yargs router) → commands/{tree,remove,list,status,recent,prune,sync,
wd-bin.ts → forwards argv to `diff`     dash,web,config,init,todo,run,broadcast,diff,hook}.ts
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
                                  ├── core/fleet.ts         ← run/broadcast session selection
                                  ├── core/broadcast.ts     ← queue a prompt to live sessions
                                  ├── core/notifier.ts      ← desktop notifications
                                  ├── core/status-hooks.ts  ← user shell hooks on status change
                                  └── core/port-allocator.ts← deterministic free-port pick

                                  Diff / review stack       ← `wd` + `work web`
                                  ├── diff-pipeline.ts      ← computeDiff(): git diff + untracked + lcov
                                  ├── diff-parse.ts         ← unified-diff parser
                                  ├── checkpoint.ts         ← per-scope working-tree snapshots
                                  ├── lcov.ts               ← coverage parsing (cached)
                                  ├── diff-server.ts        ← shared Hono server (chokidar + SSE)
                                  ├── comment-*.ts          ← review comment model + file store
                                  ├── scope-manager.ts      ← in-memory scope registry
                                  └── static-renderer.ts    ← self-contained HTML (`wd --static`)

                                  web/src/                  ← React SPA (Vite → dist/web/)
                                  ├── apps/ReviewApp.tsx    ← single-scope view (wd / wd -c)
                                  ├── apps/DashboardApp.tsx ← multi-session view (work web)
                                  └── components/           ← Diff/, Review/, Sidebar/, Terminal/

                                  core/web-server.ts        ← `work web` dashboard (Hono + SSE + WS)
                                  ├── scope-routes / panes-routes / worktree-routes / *-comment-routes
                                  ├── pty-pool.ts           ← per-session Claude PTY pool
                                  └── command-hook-installer.ts ← UserPromptSubmit/Stop hooks

                                  tui-ink/                  ← Ink/React TUI (`work dash`)
                                  └── App / Sidebar / TerminalPane / StatusBar

                                  tui/session.ts            ← node-pty + @xterm/headless (shared)
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
│   ├── core/                   # Shared operations (worktree, git, history, diff, web, …)
│   ├── web/                    # React SPA — diff/review UI + work web dashboard (Vite → dist/web/)
│   ├── tui-ink/                # Ink/React TUI dashboard
│   ├── tui/                    # PTY sessions and hook server
│   ├── completions/            # Dynamic tab-completion handler
│   └── utils/
├── tests/                      # vitest suites
├── tsup.config.ts
└── package.json
```

---

## Unsafe Mode & Debug Logging

`--unsafe` on `work tree`, `work resume`, or `work dash` passes the AI tool's skip-permissions flag (`--dangerously-skip-permissions` for Claude Code; configurable per tool via `aiCommandFlags`) — useful in trusted, sandboxed worktrees, dangerous everywhere else. Use deliberately.

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

Yes. Set `aiCommand` in `~/.work/config.json` to any CLI (and adjust `aiCommandFlags` for that tool's unsafe / resume / prompt-file flag names). Work will launch it on `work tree` and embed it in the dashboard terminal the same way. Claude Code remains the default and the only tool with first-class group `CLAUDE.md` generation and the review hook bridge.
</details>

---

## License

MIT — see [LICENSE](LICENSE).

---

<div align="center">

**Work — Git Worktree Manager** v1.5.0 · [Moberg d.o.o.](https://www.moberg.hr)

Built for engineers who run more than one branch at a time.

</div>
