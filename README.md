# Work - Git Worktree Manager

A PowerShell tool for managing git worktrees across multiple repositories. Create isolated workspaces per branch, manage multi-repo groups, and launch Claude Code automatically.

## Installation

1. Clone this repository
2. Dot-source the script in your PowerShell profile (`$PROFILE`):

```powershell
. C:\path\to\work-tree\work.ps1
```

3. Run initial setup:

```powershell
work init
```

This walks you through configuring:
- **Worktrees root** — where all worktrees are created
- **Repositories** — each gets an alias (e.g., `ai` → `C:\repos\ai-service`)

## Quick Start

```powershell
# Create a worktree and launch Claude Code
work tree ai feature/login

# Create a worktree and open the .sln in your IDE
work tree ai feature/login open

# List all active worktrees
work list

# Remove a worktree (blocks if uncommitted/unpushed changes)
work remove ai feature/login

# Force remove
work remove ai feature/login -Force
```

## Configuration

Manage repos and groups without editing JSON directly:

```powershell
# Add a repository
work config add frontend C:\repos\frontend-app

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
- `.claude\settings.local.json` — Claude Code local settings

Edit the config to customize which files are copied.

## Groups (Multi-Repo Worktrees)

Groups let you create a single worktree workspace containing multiple repositories, useful when a feature spans several repos.

```powershell
# Create a group
work config addgroup mygroup api frontend shared-lib

# Create worktrees for all repos in the group
work tree mygroup feature/new-checkout

# Remove all worktrees in the group
work remove mygroup feature/new-checkout

# Regenerate the combined CLAUDE.md for a group
work config regengroup mygroup

# Delete a group
work config removegroup mygroup
```

Group worktrees are organized as:

```
<worktreesRoot>/
  mygroup/
    feature-new-checkout/
      api/              ← worktree for api repo
      frontend/         ← worktree for frontend repo
      shared-lib/       ← worktree for shared-lib repo
      CLAUDE.md         ← auto-generated combined instructions
```

When creating a group, a combined `CLAUDE.md` is generated using Claude CLI by merging each repo's individual `CLAUDE.md`.

## Tab Completion

Full tab completion is registered automatically when the script is loaded. Completions are context-aware:

- Commands: `tree`, `remove`, `list`, `init`, `config`
- Config actions: `add`, `remove`, `addgroup`, `removegroup`, `regengroup`, `list`, `show`, `edit`
- Project/group names from your config
- Branch names from existing worktrees
- Switches: `-Force`, `-Unsafe`

## Unsafe Mode

Skip Claude Code permission checks when launching:

```powershell
work tree ai feature/hotfix -Unsafe
```

This passes `--dangerously-skip-permissions` to the Claude CLI.

## Requirements

- PowerShell 5.1+
- Git
- [Claude Code CLI](https://claude.ai/code) (for automatic Claude launching and group CLAUDE.md generation)
