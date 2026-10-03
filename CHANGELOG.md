# Changelog

Notable changes per release. Releases up to 1.16.0 are described in the
[GitHub Releases](https://github.com/moberghr/cli-work-tree-manager/releases).

## Unreleased (2.0.0)

### Dashboard (`work web`)
- The Inbox: who needs you, with Allow / Deny for permission prompts, snooze,
  "blocked by" a session or PR, and a Review queue over finished sessions.
- Sessions table with bulk actions; pins, sections and drag order in the rail;
  Ctrl+P to jump, Alt+1…9, j/k; a right-click menu per session.
- Per session: the Last turn diff, a Timeline, Catch me up, Notes, time worked
  (with Jira worklogs), context usage, "same files as" overlap warnings,
  behind-main with Update from main.
- Stacked sessions: a session made from another's branch follows it, and moves
  onto main when it merges. Fork a session from where it is.
- The PR watch: CI failures and review feedback go to the session's agent,
  which drafts replies; you post them. Merged work archives itself.
- Archive keeps everything — the conversation, uncommitted work, drafts and
  notes — and Restore brings it back. Conversations are kept and searchable
  beyond the agent's own retention.
- Activity panel (what runs in the background, and why), Today digest, the
  Ctrl+K assistant, the Jira watch, desktop notifications that follow where
  you're looking, a headless Chat tab.

### CLI
- Talk to sessions from anywhere: `work read`, `screen`, `send`, `wait`,
  `start`, `stop`, `answer`.
- Session actions: `work update`, `catchup`, `snooze`, `pin`, `section`,
  `note`, `block`, `time`, `fork`, `cleanup`, `search`, `digest`, `sessions`,
  `overlaps`, `state`.
- Sessions run in the PTY host by default: they survive restarts and reboots,
  and the dashboard shows the same terminal.

### Platform
- Session state moved to SQLite (`~/.work/state.db`), imported from the old
  files on first start.
- The desktop app (Windows, macOS arm64, Linux) ships through Velopack with the
  CLI inside.
- Agents behind an adapter interface: Claude Code today, others ready to plug
  in.

### Engineering
- `src/core` split by feature, the HTTP front-end in `src/server`.
- Tests are typechecked; ESLint; coverage report; Dependabot; an audit gate on
  shipped dependencies; only what the CLI imports is shipped.
