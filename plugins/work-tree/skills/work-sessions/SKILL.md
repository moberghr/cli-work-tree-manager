---
name: work-sessions
description: Look up and act on the user's `work` worktree sessions — which sessions exist and what state they're in (needs input, working, idle, stale), what each did today, which two sessions change the same files, and which worktrees can be cleaned up. Use when the user asks about their sessions, worktrees or branches across repos ("what's running", "what did I do today", "which sessions touch payments.ts", "clean up old worktrees", "is anything waiting on me"), or when you need that data to answer them. Not for the current repo's own git state — use git for that.
---

# The user's work sessions, as data

`work` manages git worktrees and the Claude session in each. The dashboard (`work web`) and these commands read the same state, so what you get here is what the user sees there. Always use `--json` and parse it; don't scrape the human output.

## Reading (safe — run freely)

| Question | Command |
|---|---|
| Which sessions exist, their status and age | `work sessions --json` (this week; `--all` adds older and archived ones; `work sessions <alias> --json` for one repo or group) |
| …plus uncommitted `+N −M` and same-file overlaps | `work sessions --json --changes` (runs git in each live session: a few seconds) |
| What each session did (your prompts, turns, status, PRs) | `work digest --json` (`--since today\|yesterday\|week\|<date>`); without `--json` it prints a Markdown standup note |
| Which live sessions change the same files | `work overlaps --json` |
| What a past or current session said about something ("what did we do about X?") | `work search <words> --json` (every session's conversation, live and archived, also older than Claude Code keeps) |
| Which worktrees can go, and why | `work cleanup --json` (fetches origin first; `--no-fetch` to skip) |

`work sessions --json` rows are the dashboard's rows plus a `view` block:
- `view.label` is the status the user sees ("Needs your input", "Working", "Done", "Idle", "Stale"), and `view.age` is `now | week | older`.
- `attention.summary` is the one line the dashboard shows: the last prompt while working, Claude's last message when done, or the permission request when blocked.
- `context.used / context.window` is how full that session's conversation is.

## Acting (changes things — ask the user first)

`work cleanup --json` returns candidates with `verdict` and `suggested`:

- `merged`: nothing uncommitted, and nothing the main branch lacks. Safe to remove; the branch itself is kept.
- `gone`: the folder no longer exists; only the session entry is left.
- `work` / `dirty`: has commits or uncommitted changes of its own. Never remove these; archiving (hides it, stops its Claude, keeps everything) is suggested after a week quiet.

To act: `work cleanup --apply <sessionId> [<sessionId>…] --action delete|archive|forget --json`. Each one is checked again right before anything happens, and one that no longer qualifies is refused with the reason (`ok: false`). Show the user the list and the reasons, and get a yes before running `--apply`. Never pass `--force` (it discards uncommitted changes) unless the user asked for exactly that.

Other actions go through the user's normal commands (`work remove`, `work tree`), or through the dashboard.

## Don'ts

- Don't post on GitHub, and don't message other sessions' Claudes, on your own.
- Don't guess session state from the filesystem when a command above answers it.
