# Changelog

Notable changes per release. Releases up to 1.16.0 are described in the
[GitHub Releases](https://github.com/moberghr/cli-work-tree-manager/releases).

## Unreleased

- Who opened a pull request on GitHub: "by @dana" on each PR's section in a
  session's PR tab, and on Start's rows for PRs that aren't yours.

## 2.0.8 — 2026-10-08

- Restore of a session whose worktree git removed only in part brings it
  back. `git worktree remove` stops at a file in use (Visual Studio's), after
  dropping the folder's git link: archiving read that as "kept" and dropped
  its save of the uncommitted files, and Restore, seeing the folder, only
  un-archived it — a folder with no git, shown as "a detached HEAD". Now the
  archive counts it removed and keeps the save, and Restore (or `work tree`)
  sets what's left aside, makes the worktree again on its branch, puts the
  save back and copies the files that were left over it. The dashboard says
  "not a git checkout any more" for such a folder.
- A terminal whose Claude was stopped from outside — `work stop`, Archive,
  Delete — no longer freezes in an open tab, taking no input: the tab is
  told it ended and offers Enter to start it again. ⋯ → **Reconnect
  terminal** (⇧R) reconnects whenever a tab seems stuck. (The fix is in
  the PTY host: `work pty-host --restart` once after updating.)
- A reply to a PR review thread is never posted when the last word in it is
  already yours (a PR author's Claude once answered his own comment as if
  it were a reviewer's), or when the thread was resolved since: work reads
  the thread on GitHub right before posting. And when gh can't say who you
  are, no review feedback is handed to Claude at all.
- Restore brings a session back as it was before Archive. Besides the
  branch, the worktree and the uncommitted files, it now keeps the
  worktree's git-ignored files that aren't build output — local settings
  like `appsettings.Development.json` or `.env.local`, and the editor's
  state (`.vs`) — and the Diff tab's turns (archiving deleted them). A
  Restore that can't make the worktree says why.

## 2.0.7 — 2026-10-08

- Work on someone else's pull request, on their branch: what you push lands
  in their PR. New worktree → **Start from a pull request…** (paste its link,
  or its number in the project picked), **Work on it** beside Review on
  Start's "Waiting for your review", or `work tree --pr <link>` (`--pr 12
  <repo>`). The repo and branch come from the PR, and its Claude is told
  whose branch it is, to get up to speed and wait for what you want, and to
  post nothing on GitHub (with `--prompt`, what to do after reading up). A
  PR from a fork is refused: its branch isn't on origin, so nothing could be
  pushed to it; a fork's **Review** now opens on a branch of its own and
  checks the PR out there (it used to open an empty branch of that name).
- A session on someone else's PR — working on it or reviewing it — is no
  longer handed that PR's review threads (they're its author's) or asked to
  fix its failing checks: the PR watch tells your PRs from others' by author.

## 2.0.6 — 2026-10-07

- Creating a worktree is faster, and leaves your main checkout alone: a
  branch that already exists (a group's, made first in each repo) is brought
  up to its upstream by moving its ref, where work used to check it out in
  your main checkout, pull, and check the old branch out again (~10 s a repo
  on a big one). The main checkout is pulled only when the new branch starts
  from it. Git writes the worktree's files in parallel (`checkout.workers`:
  6-8.6 s became 2 s for 5,000 files on Windows), and a group's repos fetch
  at the same time. A two-repo group that took 46 s should take about 10.

## 2.0.5 — 2026-10-07

- Context on Opus 5 reads against its 1M window: the header said 96% where
  Claude Code's own line said 19%.
- A group's merged PR keeps its pill (purple, as on GitHub) beside the one
  still open, in the rail and the header: you see it had one, and merged it.
- A session's pull requests have their own tab, **PR** (key 3; Timeline is 4):
  one section per PR — a group's repos, and a second PR from the same branch —
  with its stage, checks (Ask Claude to fix), Ship…, and its review threads
  and drafts. One "Ask Claude about all" on top for every thread with no
  reply. The header keeps one "Needs you" line that opens the tab, so the
  terminal keeps its height however many threads there are.

## 2.0.4 — 2026-10-06

- `brew install moberghr/work-tree/work` builds its native modules again:
  npm skipped their install scripts, so better-sqlite3 was never compiled
  (every `work hook` failed) and node-pty couldn't start terminals. The
  release now writes the tap's formula from the one in the repo, so changes
  to it reach the tap.
- The desktop app's updates apply again on Windows. The app started work web
  from its own install folder, which Windows then wouldn't let Velopack move,
  so Restart came back on the old version (2.0.2 → 2.0.3 did, every time).
  The app and the servers work starts in the background now run from the
  home folder. Updating from 2.0.3 still needs work web stopped once: quit the
  app, `work web --stop`, start the app.

## 2.0.3 — 2026-10-06

- Terminals start in the macOS desktop app again: node-pty's `spawn-helper`
  shipped without its executable bit ("posix_spawnp failed"). The app's
  build sets it and opens a terminal before it ships, and work fixes the bit
  itself before the first terminal, on any install (brew and npm too).
- The Diff tab, like the standalone review page: one toolbar over the
  diff, and **Changes ▾** — the branch's commits and Claude's turns in one
  list, newest first. Click one to see just it, Shift+click for a span
  across commits and turns, in either scope. Last turn and Since you looked
  are its shortcuts. Loading keeps the diff on screen with a thin bar under
  the toolbar; a group opens on the repo that has changes; no comments is
  one line, not half the sidebar.
- A session's turns survive its commits: each commit used to wipe them
  back to "Initial", so a session where Claude committed as it went had
  no turns to pick.

- The desktop app shows an update's download as it happens: a progress bar
  with the percentage, on the card and in the version menu, then Restart, then
  "Installing…" until the app is back. The app tells its own window directly,
  so what it shows is always the app's own version and update.
- For working on work: `work web --dev`, a second server with a checkout's
  build next to the real one, on your real sessions (no hooks, notifications
  or background jobs; it refuses a build that would migrate the database), and
  the dev app — `npm run app:dev` / `npm run app:demo`, "work dev" with DEV on
  its icon — side by side with the installed app.
- PR review comments: Claude now plans and changes nothing. Per comment it
  says what it would change (or why not) and drafts the reply; it edits,
  commits, pushes and posts only once you say yes, since a reviewer can be
  wrong. CI failures are still fixed and pushed straight away.
- A long review round no longer reaches Claude cut off before the
  instructions (it then drafted its replies in the chat, where the dashboard
  can't see them). Several threads with no reply fold under one heading, with
  one "Ask Claude about all".
- A group session is no longer archived while one of its PRs is still open
  when GitHub or git didn't answer (right after the computer woke): a repo
  that couldn't be read was taken for one with nothing in it.
- `work web --dev --stop` works on Linux: a server that has exited is no
  longer taken for a running one.

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
