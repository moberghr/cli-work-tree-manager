# Work - Git Worktree Manager

A cross-platform CLI tool for managing git worktrees across multiple repositories. Create isolated workspaces per branch, manage multi-repo groups, and launch Claude Code automatically.

## Installation

Requires **Node.js 18+** and **Git**.

```bash
# Clone and install globally
git clone <repo-url> work-tree
cd work-tree
npm install
npm run build
npm link
```

This registers the `work` command globally.

Run initial setup:

```bash
work init
```

This walks you through configuring:
- **Worktrees root** — where all worktrees are created
- **Repositories** — each gets an alias (e.g., `ai` → `/home/user/repos/ai-service`)

## Quick Start

```bash
# Create a worktree and launch Claude Code
work tree ai feature/login

# Create a worktree branching from a specific base branch
work tree ai feature/login --base develop

# Create a worktree and open VS Code
work tree ai feature/login --open

# Create a worktree with an initial prompt for Claude
work tree ai feature/login --prompt "Implement the login page"

# List all active worktrees
work list

# Remove a worktree (blocks if uncommitted/unpushed changes)
work remove ai feature/login

# Force remove
work remove ai feature/login --force

# Check status of tracked worktrees (merge status, changes, timestamps)
work status
work status ai feature/login

# List recent sessions
work recent

# Resume a recent session interactively
work resume

# Remove worktrees for merged branches (interactive picker)
work prune

# Remove all merged worktrees without prompting
work prune --force
```

## Configuration

Manage repos and groups without editing JSON directly:

```bash
# Add a repository
work config add frontend /path/to/frontend-app

# Remove a repository
work config remove frontend

# List all repos and groups
work config list

# View raw config
work config show

# Open config in editor
work config edit
```

Configuration is stored at `~/.work/config.json`.

### File Copying

New worktrees automatically get copies of files matching patterns in `copyFiles`. Default patterns:

- `*.Development.json` — local dev settings
- `*.Local.json` — local overrides
- `.claude/settings.local.json` — Claude Code local settings

Edit the config to customize which files are copied.

## Groups (Multi-Repo Worktrees)

Groups let you create a single worktree workspace containing multiple repositories, useful when a feature spans several repos.

```bash
# Create a group
work config group add mygroup api frontend shared-lib

# Create worktrees for all repos in the group
work tree mygroup feature/new-checkout

# Remove all worktrees in the group
work remove mygroup feature/new-checkout

# Regenerate the combined CLAUDE.md for a group
work config group regen mygroup

# Delete a group
work config group remove mygroup
```

Group worktrees are organized as:

```
<worktreesRoot>/
  mygroup/
    feature-new-checkout/
      api/              <- worktree for api repo
      frontend/         <- worktree for frontend repo
      shared-lib/       <- worktree for shared-lib repo
      CLAUDE.md         <- auto-generated combined instructions
```

When creating a group, a combined `CLAUDE.md` is generated using Claude CLI by merging each repo's individual `CLAUDE.md`.

## Tab Completion

Completions are automatically installed during `work init`. You can also install them standalone:

```bash
work completion --install
```

This detects your available shells and appends the completion line to each profile. On Windows, both PowerShell 7 and PowerShell 5.1 are set up. On Unix, your default shell (bash/zsh) is detected from `$SHELL`.

**Manual setup** — if auto-install doesn't work, add one line to your shell profile:

**PowerShell** — add to `$PROFILE`:

```powershell
work completion --shell powershell | Out-String | Invoke-Expression
```

**Bash** — add to `~/.bashrc`:

```bash
eval "$(work completion)"
```

**Zsh** — add to `~/.zshrc`:

```bash
eval "$(work completion)"
```

## Session Tracking

Every `work tree` call records the worktree in `~/.work/history.json`. This enables two commands:

### Status

```bash
# Show all tracked worktrees with merge status, uncommitted changes, unpushed commits
work status

# Filter to a specific project or branch
work status ai
work status ai feature/login

# Remove stale entries (worktree paths that no longer exist on disk)
work status --prune
```

### Recent

```bash
# List 10 most recent sessions
work recent

# Show more
work recent 20

# Interactively pick a session and resume Claude Code in it
work resume
work resume --unsafe
```

### Prune

```bash
# Interactively select and remove worktrees whose branches are merged into main/master
work prune

# Remove all merged worktrees without prompting
work prune --force
```

For groups, all sub-repos must be merged for the group to appear in the list. Per-repo merge status is printed during scanning.

## Task Tracking

Keep a local task list for things you want to work on:

```bash
# List open tasks
work todo

# Add a task
work todo add "Refactor auth module"

# Mark done / undo
work todo done 1
work todo undo 1

# Edit a task
work todo edit 1 "Refactor auth and session module"

# Remove a task
work todo rm 1

# Show completed tasks too
work todo --all
```

Tasks are stored locally in `~/.work/tasks.json`. They also appear in the dashboard's Tasks pane where you can manage them interactively and press `w` to create a worktree (`todo/<slug>` branch) for a task.

## Interactive Dashboard

```bash
work dash
```

An interactive terminal UI for managing all your worktree sessions. Features:

- **5-pane layout** — sessions, PRs, Jira, Tasks (left column), embedded terminal (right)
- **GitHub PR integration** — shows all open PRs across configured repos with status indicators:
  - ★ your PR, ✔ you approved, ✎ you reviewed with comments/changes
  - ✓ checks passing, ✗ checks failing or merge conflict, ● checks pending
  - Draft PRs shown with dimmed text
  - PRs matching local worktrees marked with `local`
- **Jira integration** — shows issues assigned to you (via `acli`), grouped by status. Select an issue to create a worktree with an auto-generated branch name and a structured planning prompt sent to Claude
- **Merged branch detection** — worktrees with merged branches are flagged
- **Auto-sync** — fetches all remotes, PR, and Jira data on startup. `g` syncs the focused pane, `G` syncs everything
- **Session resume** — returning to a worktree resumes the last Claude conversation (`--continue`)
- **Active session indicator** — green `▸` marks the session currently shown in the terminal pane
- **Task management** — view, add, edit, complete, and remove tasks directly in the TUI. Press `w` on a task to create a worktree with a `todo/<slug>` branch
- **Base repo launch** — press `n`, select a project, and press Enter with an empty branch name to launch Claude on the base repo directly
- **Create worktrees from PRs, Jira, or tasks** — select a PR, Jira issue, or task to create/resume a worktree for it. Press `o` on a Jira issue to open it in the browser
- **Mouse support** — scroll wheel navigates panes, left-click switches focus between panes. Shift+drag for text selection
- **Keyboard navigation** — `tab` cycles panes, `j/k` navigates, `enter` starts, `n` creates new, `d` removes, `.` opens editor, `u` rebase, `g` syncs pane, `G` syncs all

```bash
# Launch with --unsafe to skip Claude permission checks
work dash --unsafe
```

## Unsafe Mode

Skip Claude Code permission checks when launching:

```bash
work tree ai feature/hotfix --unsafe
```

This passes `--dangerously-skip-permissions` to the Claude CLI.

## Debug Logging

All CLI output and internal debug messages are logged to `~/.work/debug.log` with timestamps. Useful for diagnosing worktree creation failures or hook issues. The log auto-rotates at 5MB.

## Requirements

- Node.js 18+
- Git
- [Claude Code CLI](https://claude.ai/code) (for automatic Claude launching and group CLAUDE.md generation)
- [GitHub CLI (`gh`)](https://cli.github.com/) (optional, for PR integration in dashboard)
- [Atlassian CLI (`acli`)](https://developer.atlassian.com/cloud/acli/) (optional, for Jira integration in dashboard)
