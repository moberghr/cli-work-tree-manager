# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A PowerShell-based Git worktree manager (`work.ps1`) that simplifies creating, listing, and removing git worktrees across multiple repositories. It supports both single-repo and multi-repo "group" worktrees, with automatic Claude Code launching.

## Usage

The script is dot-sourced into a PowerShell session to register the `work` function and its tab completer:

```powershell
. .\work.ps1
```

## Architecture

**Single file:** `work.ps1` contains all logic — no modules, no dependencies beyond Git and PowerShell.

**Configuration:** Stored at `~/.work/config.json`. Schema:
- `worktreesRoot` — parent directory for all worktrees
- `repos` — map of alias to repo path (e.g., `{"ai": "C:\\repos\\ai-service"}`)
- `groups` — map of group name to array of repo aliases
- `copyFiles` — glob patterns for files to copy from main repo into new worktrees (e.g., local dev settings, `.claude/settings.local.json`)

**Key design patterns:**
- `New-SingleWorktree` / `Remove-SingleWorktree` are the atomic building blocks — they handle one repo's worktree. Group operations loop over these with rollback on failure.
- Branch resolution order: local exists → remote exists (creates tracking branch) → neither (creates new branch).
- `Resolve-ProjectTarget` is the dispatcher that determines if a name is a group or single repo, returning a uniform object with `IsGroup`, `Name`, and `RepoAliases`.
- Group worktrees live at `<worktreesRoot>/<groupName>/<branch-dir>/` with each repo as a subdirectory. Single-repo worktrees live at `<worktreesRoot>/<repoFolderName>/<branch-dir>/`.
- Branch directory names use `-` instead of `/` (e.g., `feature/login` → `feature-login`).

**Group CLAUDE.md generation:** `Generate-GroupClaudeMd` pipes each repo's CLAUDE.md into `claude -p` to produce a combined CLAUDE.md for multi-repo workspaces. Falls back to a concatenated template if the Claude CLI call fails.

**Tab completion:** A single native completer (`Register-ArgumentCompleter -Native`) handles all positional and switch completions context-sensitively based on cursor position and preceding arguments.
