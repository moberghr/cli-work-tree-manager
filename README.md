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

This registers the `work2` command globally.

Run initial setup:

```bash
work2 init
```

This walks you through configuring:
- **Worktrees root** — where all worktrees are created
- **Repositories** — each gets an alias (e.g., `ai` → `/home/user/repos/ai-service`)

## Quick Start

```bash
# Create a worktree and launch Claude Code
work2 tree ai feature/login

# Create a worktree branching from a specific base branch
work2 tree ai feature/login --base develop

# Create a worktree and open VS Code
work2 tree ai feature/login --open

# List all active worktrees
work2 list

# Remove a worktree (blocks if uncommitted/unpushed changes)
work2 remove ai feature/login

# Force remove
work2 remove ai feature/login --force

# Check status of tracked worktrees (merge status, changes, timestamps)
work2 status
work2 status ai feature/login

# List recent sessions
work2 recent

# Resume a recent session interactively
work2 resume

# Remove worktrees for merged branches (interactive picker)
work2 prune

# Remove all merged worktrees without prompting
work2 prune --force
```

## Configuration

Manage repos and groups without editing JSON directly:

```bash
# Add a repository
work2 config add frontend /path/to/frontend-app

# Remove a repository
work2 config remove frontend

# List all repos and groups
work2 config list

# View raw config
work2 config show

# Open config in editor
work2 config edit
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
work2 config group add mygroup api frontend shared-lib

# Create worktrees for all repos in the group
work2 tree mygroup feature/new-checkout

# Remove all worktrees in the group
work2 remove mygroup feature/new-checkout

# Regenerate the combined CLAUDE.md for a group
work2 config group regen mygroup

# Delete a group
work2 config group remove mygroup
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

Completions are automatically installed during `work2 init`. You can also install them standalone:

```bash
work2 completion --install
```

This detects your available shells and appends the completion line to each profile. On Windows, both PowerShell 7 and PowerShell 5.1 are set up. On Unix, your default shell (bash/zsh) is detected from `$SHELL`.

**Manual setup** — if auto-install doesn't work, add one line to your shell profile:

**PowerShell** — add to `$PROFILE`:

```powershell
work2 completion --shell powershell | Out-String | Invoke-Expression
```

**Bash** — add to `~/.bashrc`:

```bash
eval "$(work2 completion)"
```

**Zsh** — add to `~/.zshrc`:

```bash
eval "$(work2 completion)"
```

## Session Tracking

Every `work2 tree` call records the worktree in `~/.work/history.json`. This enables two commands:

### Status

```bash
# Show all tracked worktrees with merge status, uncommitted changes, unpushed commits
work2 status

# Filter to a specific project or branch
work2 status ai
work2 status ai feature/login

# Remove stale entries (worktree paths that no longer exist on disk)
work2 status --prune
```

### Recent

```bash
# List 10 most recent sessions
work2 recent

# Show more
work2 recent 20

# Interactively pick a session and resume Claude Code in it
work2 resume
work2 resume --unsafe
```

### Prune

```bash
# Interactively select and remove worktrees whose branches are merged into main/master
work2 prune

# Remove all merged worktrees without prompting
work2 prune --force
```

For groups, all sub-repos must be merged for the group to appear in the list. Per-repo merge status is printed during scanning.

## Interactive Dashboard

```bash
work2 dash
```

An interactive terminal UI for managing all your worktree sessions. Features:

- **Split-pane layout** — sessions pane (top-left) and PR pane (bottom-left) with an embedded terminal (right)
- **GitHub PR integration** — shows all open PRs across configured repos with status indicators:
  - ★ your PR, ✔ you approved, ✎ you reviewed with comments/changes
  - ✓ checks passing, ✗ checks failing or merge conflict, ● checks pending
  - Draft PRs shown with dimmed text
  - PRs matching local worktrees marked with `local`
- **Merged branch detection** — worktrees with merged branches are flagged
- **Auto-sync** — fetches all remotes and PR data on startup
- **Create worktrees from PRs** — select a PR to create/resume a worktree for its branch
- **Keyboard navigation** — `tab` cycles panes, `j/k` navigates, `enter` starts, `n` creates new, `d` removes, `.` opens editor, `g` syncs

```bash
# Launch with --unsafe to skip Claude permission checks
work2 dash --unsafe
```

## Unsafe Mode

Skip Claude Code permission checks when launching:

```bash
work2 tree ai feature/hotfix --unsafe
```

This passes `--dangerously-skip-permissions` to the Claude CLI.

## Requirements

- Node.js 18+
- Git
- [Claude Code CLI](https://claude.ai/code) (for automatic Claude launching and group CLAUDE.md generation)
- [GitHub CLI (`gh`)](https://cli.github.com/) (optional, for PR integration in dashboard)
