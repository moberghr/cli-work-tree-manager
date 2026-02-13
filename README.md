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

# Create a worktree and open VS Code
work2 tree ai feature/login --open

# List all active worktrees
work2 list

# Remove a worktree (blocks if uncommitted/unpushed changes)
work2 remove ai feature/login

# Force remove
work2 remove ai feature/login --force
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
work2 config addgroup mygroup api frontend shared-lib

# Create worktrees for all repos in the group
work2 tree mygroup feature/new-checkout

# Remove all worktrees in the group
work2 remove mygroup feature/new-checkout

# Regenerate the combined CLAUDE.md for a group
work2 config regengroup mygroup

# Delete a group
work2 config removegroup mygroup
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

Add one line to your shell profile for context-aware completions (commands, project names, branches):

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
