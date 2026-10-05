# Changelog

Notable changes per release. Releases up to 1.16.0 are described in the
[GitHub Releases](https://github.com/moberghr/cli-work-tree-manager/releases).

## Unreleased

- The desktop app shows an update's download as it happens: a progress bar
  with the percentage, on the card and in the version menu, then Restart, then
  "Installing…" until the app is back. The app tells its own window directly,
  so what it shows is always the app's own version and update.

## 2.0.2

- The desktop app installs an update in seconds, not a minute and a half: it
  carries the CLI as one archive (and half the files it had), unpacked once
  under `~/.work/runtime`. Restart says it's installing until the app is back.
- The app runs its own work web: one of another version that is already
  running (a dev checkout's, the one from before an update) is replaced, so
  its version and updates are the app's. Your Claudes keep running.
- Comments and work's notes to a session's Claude are resolved once its turn
  ends, and the Diff tab's badge counts only open ones: no more resolving or
  deleting them by hand.
- The version comes from the release tag: `package.json` keeps `0.0.0-dev`,
  and a local build says what it is (`2.0.2-dev.3+aeed538`).

## 2.0.1 — 2026-10-05

- A review reply posted from a session (`work pr post`, or Post in the
  dashboard) no longer leaves the session saying a thread waits on you: the
  thread leaves the Needs you line, the review count and the Inbox at once.
- `work pr post` resolves each thread it answers; `--no-resolve` leaves one
  open, for a question a person should answer.

## 2.0.0 — 2026-10-05

### Upgrading
- Node 22.13 or newer.
- `work dash` is gone: use `work web` (the dashboard) and `work attach` (a
  real terminal on any session, the same Claude the dashboard shows).
- Session state moves to SQLite (`~/.work/state.db`), imported from the old
  files on first start; `work state --export <dir>` writes it back as files.
- Sessions' Claudes now run in the PTY host, a background process that starts
  by itself: closing a terminal or restarting `work web` no longer stops them.

### Dashboard (`work web`)
- The Inbox: only what wants you, with Allow / Deny for permission prompts,
  snooze, "blocked by" a session or PR, and a Review queue over finished
  sessions.
- In review: a session whose PR waits on others leaves the Inbox, and comes
  back when the PR wants you (ready to merge, a conflict, failing checks). PR
  pills on every rail row and in the session header, each linked.
- A quieter layout: Inbox, Sessions, Start and Jira; a two-line rail row per
  session; the session page with one button, a ⋯ menu and a "Needs you" line.
- Sessions table with bulk actions; pins, sections and drag order in the rail;
  Ctrl+P to jump, Alt+1…9, j/k; a right-click menu per session; keyboard
  shortcuts for every session action, and `?` to list them.
- Per session: Since you looked and Last turn diffs, a Timeline, Catch me up,
  Notes, time worked (with Jira worklogs), context usage, "same files as"
  overlap warnings, behind-main with Update from main.
- Stacked sessions: a session made from another's branch follows it, and moves
  onto main when it merges. Fork a session from where it is.
- The PR watch: CI failures and review feedback go to the session's agent,
  which drafts replies; you post them. Merged work archives itself (never a
  repo's own checkout).
- Archive keeps everything — the conversation, uncommitted work, drafts and
  notes — and Restore brings it back. Conversations are kept and searchable
  beyond the agent's own retention.
- Start: New worktree from a prompt, your PRs and reviews; the Repos page
  (scan folders, add or ignore repos, manage groups); a Welcome page on a
  fresh computer.
- Activity panel (what runs in the background, and why), Today digest, the
  Ctrl+K assistant, the Jira watch, desktop notifications that follow where
  you're looking.
- Updates: the version on the top bar opens Help — Check for updates, What's
  new (the release notes), keyboard shortcuts — and the app says when there's
  a new version.

### CLI
- Talk to sessions from anywhere: `work read`, `screen`, `send`, `wait`,
  `start`, `stop`, `answer`.
- Session actions: `work update`, `catchup`, `snooze`, `pin`, `section`,
  `note`, `block`, `time`, `fork`, `cleanup`, `search`, `digest`, `sessions`,
  `overlaps`, `state`.
- `work move export` / `import`: take your sessions and conversations to
  another computer. `work init` finds the repos in your repos folder.
- Sessions run in the PTY host by default: they survive restarts and reboots,
  and the dashboard shows the same terminal.

### Platform
- The desktop app (Windows, macOS arm64, Linux) ships through Velopack with the
  CLI inside, and updates itself.
- Agents behind an adapter interface: Claude Code today, others ready to plug
  in.
- Faster: each `work` command loads only itself, hooks start leaner, archived
  sessions load only when shown, a smaller dashboard; one GitHub search for
  every PR list.
- The terminal gets its GPU renderer back after a GPU reset.

### Engineering
- `src/core` split by feature, the HTTP front-end in `src/server`.
- Tests are typechecked; ESLint; coverage report; Prettier; an audit gate on
  shipped dependencies; only what the CLI imports is shipped; a lockfile
  (`npm-shrinkwrap.json`) for global installs.
