# Changelog

Notable changes per release. Releases up to 1.16.0 are described in the
[GitHub Releases](https://github.com/moberghr/cli-work-tree-manager/releases).

## 2.3.1 — 2026-10-20

- **Merge conflicts go to the session's Claude.** When one of a session's
  pull requests gets a merge conflict, its Claude is asked to merge the base
  branch in (never a rebase or force push), resolve it, check the build and
  tests, and push. A conflict that takes a decision comes to you as a
  question instead of a guess. On by default; `prWatch.fixConflicts: false`
  turns it off.
- **Sessions start on a Mac app opened from the Dock.** The app got the
  system's minimal PATH, so `claude` wasn't found and every session ended at
  once with "session exited with code 1". work now takes the PATH your login
  shell sets up when it can't find the agent. If you hit this before, run
  `work pty-host --restart` once in Terminal after updating.
- **A worktrees folder you can't create is refused in words.** `work init`
  now creates the folder as you enter it (and expands `~`), and asks again
  when it can't. Creating a worktree under one says what's wrong and where
  to change it (`worktreesRoot`, `work config edit`), instead of a
  permission error's stack trace.

## 2.3.0 — 2026-10-16

- **A session that handed its work to a background agent reads Working.**
  When Claude ends its turn by starting a background agent, the session no
  longer shows Idle while that agent works: it reads Working until the
  agent's result comes back as a new turn. One whose agent has been quiet
  for 15 minutes is taken as finished.
- **Pull requests show right after a restart.** work keeps each session's
  last pull-request check, so after work web or the app restarts the rail
  and the session header show its PRs at once, instead of after the first
  check reaches it a minute or two later.
- **A worktree on another branch finds its PR.** When Claude (or you)
  switched a session's worktree to another branch, its pull request on that
  branch now shows in the rail and the header, and Start links that PR to
  the session.
- **No more console windows flashing on Windows.** Open in editor, desktop
  notifications, status hooks and opening a link each flashed a console
  window for a moment; they no longer do.

## 2.2.1 — 2026-10-15

- **A space in a branch name becomes a dash.** In New worktree's and
  Fork's branch field, `fix login bug` becomes `fix-login-bug` as you type
  or paste; several spaces (and dashes around them) become one dash, and the
  cursor stays where you were typing.
- A new README and [website](https://moberghr.github.io/cli-work-tree-manager/):
  the app first, with every feature and what it does for you.

## 2.2.0 — 2026-10-15

- **Code tab.** A session has a fourth tab, **Code** (key `4`): its files,
  read only. The tree lists what git does (tracked files and new ones that
  aren't ignored), a group's repos as folders. Files changed on the branch
  have a dot, with **See the change** to the Diff. A file Claude changes
  while you read it isn't swapped under you: "File changed · Reload".
  **Open in editor** opens the file in your editor at the line you're
  reading (VS Code in the worktree's window; JetBrains and Sublime at the
  line too).
- **Search the code (Ctrl+T).** As in Visual Studio: one box for types and
  members by name (C#, TypeScript/JavaScript, Python; `GPJ` finds
  `GetPendingJobs`), files by path, and lines with the text in them, across
  a group's repos. Enter opens the place in the Code tab at its line. Ctrl+T
  works from any tab in the desktop app; in a browser tab, which keeps
  Ctrl+T for itself, use the Code tab's search button.
- **Archived sessions in the Sessions list.** **Live · Archived · All** in
  its header, **Restore** on each archived row, and a Project column. An
  archived session says who archived it: you, Ship's merge, its pull
  request merging (the PR watch), or Clean up. The Archived list's time
  column shows when it was archived.
- **A group's repos in the Diff toolbar.** The repo switch moved from above
  the diff to the start of the toolbar. It's always there, listing every
  repo with its file count. Before, picking one repo's commit hid the other
  repos, and the only way back was through Uncommitted.
- **Archive stops what still runs from the worktree.** A dev server or
  `vite` that Claude left running held files open, so the worktree was only
  partly removed. Archive now stops processes whose program is in the
  worktree, and says what it stopped. Never your editor, its language
  servers, or a tool of yours that was only handed a file there. The PR
  watch's automatic archive stops nothing: a worktree with something still
  running is kept. Restore names what still holds a half-removed folder and
  offers to stop it.
- **New worktree names the branch from what you ask.** A Jira key gives
  `feat/<KEY>`, a pasted exception `fix/<its name>`, a question `tmp/…`,
  then a few words from your prompt. Instant, no Claude call.
- **The Inbox uses the whole width** of the window, so names and summaries
  aren't cut short on a wide screen.
- The Diff tab no longer has a reviewed checkbox or Revert on each hunk;
  **Revert file** stays.
- Timeline moved to the session's ⋯ menu.
- A restored session's Claude is no longer reported as "running in another
  terminal".
- Restore brings conversations back in the order they happened.
- What's new opens wider.

## 2.1.0 — 2026-10-14

- **The Inbox count on the taskbar.** In the desktop app, the taskbar icon
  (the Dock icon on macOS) shows how many sessions want you, and the taskbar
  button flashes when a session starts waiting on your answer, unless the
  window is already in front. The flash can be turned off in the version
  menu.
- **Since branch is right for a new branch.** A branch just made from `dev`,
  with nothing committed yet, showed every commit `dev` has that `main`
  doesn't. It now shows nothing until you commit, then only your commits. New
  worktrees remember the branch they were made from, and the diff measures
  from the freshest copy of it (yours or `origin`'s), so changes you merged
  in from it aren't counted as the branch's own.
- **Only new.** When Claude changes files while you read a diff, the "New
  changes" chip in the Diff tab now has **Only new** beside Show and Reload:
  just what changed since the diff on screen, from Claude's last turn before
  it.
- **Review comments in the diff.** A resolved comment you opened folds back
  with **Hide**, top right, where its Show was. Reply, Resolve and Delete
  are proper buttons; Delete asks once more (and says how many replies go
  with it). A reply you're writing on a resolved thread stays open. The
  comment list on the left puts resolved comments last, under their own
  heading.
- The restart card and the version menu name the sessions still running an
  old Claude Code; click one to open it.

Update the desktop app for the taskbar count (its Restart, or the next
start).

## 2.0.13 — 2026-10-13

- **Restart Claude sessions after Claude Code updates.** A running Claude
  keeps the version it started with. When Claude Code has updated, the
  version button gets a dot and a card says how many sessions still run the
  old version; **Restart them** restarts each one, picking up its
  conversation, with its terminal staying open. A session that is working or
  waiting on you restarts when its turn ends, never in the middle of it.
  From a terminal: `work restart`, `work restart <target> <branch>`,
  `work restart --outdated` or `--all`.
- **Your looks.** The Diff tab's **Changes** picker keeps what "Since you
  looked" showed you each time: **Last look** gets back the diff you
  reviewed most recently, and **Your looks** lists earlier ones (the last 20
  per session).
- Right-click a folder or a file in a diff's file tree to mark every file
  under it as viewed, or not viewed (the app's Diff tab and `wd`'s page).
- Moving to another session (the list on the left, `n`, a row of the
  Sessions table, a notification) opens it on its **Terminal** tab, whatever
  tab you were on. j/k still keep the tab, so you can walk the sessions'
  diffs from the keyboard.
- With a session open both in the app and in a terminal (`work tree`,
  `work attach`), the one you type in sets the terminal's size: opening it
  in the app no longer leaves the other terminal drawn at the app's size.
- Dragging a session in the list: letting go between two rows moves it
  where the blue bar shows, instead of doing nothing.

After updating, run `work pty-host --restart` once (it restarts your Claudes,
each picking up its conversation): restarting in place and the terminal size
fix live in the PTY host, which keeps running across updates.

## 2.0.12 — 2026-10-12

- The session's **Diff** tab has the arrows between hunks that `wd`'s own
  page has: more lines around a change, read at the version shown (the
  working tree, a commit, or one of Claude's turns).
- Comments are the same in the app and in the browser: the session's Diff
  tab lists those made on its diff page in the browser, and that page lists
  the Diff tab's. Resolving, answering or deleting one works from either.
- A Restore that can't go through says why where you clicked it — for
  example that Visual Studio still has a file open in what's left of the
  session's folder — instead of only in the button's tooltip.

## 2.0.11 — 2026-10-09

- The desktop app says when its window shows a work web of another version
  (a checkout's, an npm install's, one left from before an update): a yellow
  ⚠ in the version pill, and in its menu which versions and how to put them
  together (quit and reopen the app).

## 2.0.10 — 2026-10-09

- A **Time** tab (`g h`): each workday's hours per Jira ticket, suggested from
  what you did — Claude's working time in each session (its Jira key, or the
  key in its branch), your commits, the issues you moved — and kept current
  as you go (after each turn, every half hour, and the last two weeks' days
  you weren't running work). The timesheet tool's rules, as settings
  (`time` in config.json): a 7.5 h day, Claude time ×5 capped at 7 h, quarter
  hours, at least half an hour a ticket, the rest to a gap ticket
  (`time.gapTicket`), days off to `time.timeOffTicket`, `time.holidays`.
  Unlike the tool, a day never goes over its hours. Edit a day's rows, mark
  it off, or gather it again; your edits survive a rebuild.
- **Post to Tempo**, per day, only on your click. work reads Tempo's day
  first: what it posted before and you still want stays, what you took out
  goes, worklogs you made by hand are never touched (and one that already
  covers a row isn't posted again). Set `TEMPO_API_TOKEN` for work web and
  `time.tempo.accountId`. A day then reads "in Tempo", or "changed since
  posted".
- **Outlook meetings and Teams chats** (Connect in the Time tab: a code to
  enter at microsoft.com, with the timesheet tool's app registration in
  `time.graph`). What no ticket could be read from — a session without a
  key, a commit naming none, a meeting, a chat — is placed by the AI step
  (no tools; only on the day's candidate tickets; marked "AI"). A meeting
  on a ticket counts 1:1; the rest keep their room in the gap ticket.
- **Ask about this day** opens the Ctrl+K assistant on the day on screen,
  and `work timesheet show | set | reset | off | gather | post` does it
  all from a terminal.
- What the timesheet tool had, in `time`: **hints** (its TICKET_HINTS:
  words that mean a ticket, for worktrees and meetings that don't name it;
  `placeholder` for a ticket still to create in Jira, said on its row),
  **effort** (Claude minutes 1:1, its `build --effort`), **vacation** days,
  and **catchUpDays** (how far back, up to 92). A ticket Jira has as done
  says "resolved" on its row. Jira counts what you updated (a comment, an
  edit), not only what you moved; a meeting whose subject names a ticket,
  or a chat where someone named one, is on it without the AI step.
- The session's **Diff** tab: **Open in browser** (the diff on the page `wd`
  opens, in your browser, beside the app) and **Full screen** (the diff fills
  the window; Esc leaves).
- The **Jira** tab shows every open issue of yours: a service desk sets a
  resolution on issues still waiting for feedback, which hid them.

## 2.0.9 — 2026-10-08

- Who opened a pull request on GitHub: "by @dana" on each PR's section in a
  session's PR tab, and on Start's rows for PRs that aren't yours.
- Start's pull requests have the repo as a column of its own, and a quick
  filter above them: a chip per repo (with how many), several at once, over
  both lists — remembered in this browser.

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
