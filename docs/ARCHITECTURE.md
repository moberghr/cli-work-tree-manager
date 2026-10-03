# Architecture

How `work` is put together: the processes that run, where the code lives,
where state is kept, and how a session's agent and the dashboard talk. The
decisions behind it are in [`docs/adr/`](adr/README.md); the full reference
(every module, rule and invariant) is [`CLAUDE.md`](../CLAUDE.md), which is
also what an AI agent working on this repository reads.

## What it is

A CLI (`work`, plus `wd` for diffs) that manages git worktrees across many
repositories — one worktree per branch, optionally one per *group* of repos —
and the coding agent session working in each (Claude Code today; others
through the agent interface). Around that: a browser dashboard (`work web`)
that shows every session, its terminal, its diff and what it needs from you,
and a desktop app that wraps the dashboard.

## The processes

```
 you ──► work <command> ─────────────┐            (CLI: short-lived)
                                     ▼
 browser / desktop app ──► work web (HTTP + SSE + WS, 127.0.0.1)   one per user
                              │  ▲
              spawn / attach  │  │ hook nudge (POST /api/status-changed)
                              ▼  │
                        PTY host (127.0.0.1, token)   one per user, detached
                              │
                              ▼
                  agent processes (claude …) in each worktree
                              │
              turn edges ──►  work hook <edge>  (short-lived, run by the agent)
```

- **`work` (CLI)** — every command is a thin front-end over `src/core`.
  `work tree` creates or re-enters a worktree and attaches your terminal to
  its agent.
- **`work web`** — the dashboard server. A singleton: a second `work web`
  reuses the running one, and `wd` registers its diff scopes on it
  ([ADR 0003](adr/0003-singleton-work-web.md)). Stopping it stops nothing
  else.
- **The PTY host** — a detached process that owns every agent terminal, so
  agents survive `work web` restarts, rebuilds and reboots (they're restored
  with their conversation) and several clients can attach to one
  ([ADR 0002](adr/0002-pty-host.md)).
- **`work hook <edge>`** — installed into the agent's own settings; the agent
  runs it at the start and end of every turn and on notifications. It
  records the session's status, delivers pending review notes, and nudges
  `work web`.
- **The desktop app** — a Tauri window over `work web`, shipped through
  Velopack with the CLI inside it ([ADR 0006](adr/0006-desktop-velopack.md)).

## Where the code lives

```
src/
  commands/      the CLI front-end (one command per file)
  server/        the HTTP front-end: web-server.ts, routes/, demo/
  core/          all logic, by feature (sessions, status, diff, pr, pty, …)
    agents/      the agent interface + registry; agents/claude/ is Claude Code's
    platform/    infrastructure: state.db, config, files, processes, logging
  web/src/       the React dashboard (Vite → dist/web)
tests/           mirrors src/
```

Dependencies point one way: `commands/` and `server/` call `core/`; core
calls neither ([ADR 0005](adr/0005-core-by-feature.md)). Architecture tests
(`tests/architecture/`) enforce this and the other boundaries — React only in
the SPA, node-pty only in the PTY host, SQLite only in `platform/db.ts`,
Claude Code only in `agents/claude/`, core and server never print.

## Where state lives

All under `~/.work/`:

| What | Where |
|---|---|
| Session state: history, status, comments and their delivery, PTY restore list, PR-watch memory, snoozes, pins, notes, blocks, worklogs, tasks | `state.db` (SQLite, WAL; [ADR 0001](adr/0001-sqlite-state.md)) |
| Your configuration | `config.json` |
| Kept conversations, archives | `conversations/<id>/`, `archive/<id>/` |
| Discovery of the running servers | `web.url` / `web.pid`, `pty-host.json` |
| Logs | `debug.log`, `dev/<id>.log` |

Every `work` process (CLI, hooks, `work web`, PTY host) shares `state.db`;
read-then-write happens in one transaction. `work state --export` writes it
back in the older JSON layout.

## Agents

`work` talks to a coding agent through an adapter (`core/agents/types.ts`):
how to launch and resume it, read its conversation, hear its turns (hooks),
see its running processes, type into it and answer its permission dialog,
run it for one-shot summaries, run it headless as a chat, set up a folder
for it, and give it work's skills. Each part is optional; the dashboard hides
what an agent can't do. Claude Code is the one adapter today
([ADR 0004](adr/0004-agent-adapters.md)); `tests/core/agents/echo-agent.test.ts`
runs a made-up second one through the real modules.

## One turn, end to end

1. You send a prompt (in a terminal, the dashboard's terminal, or `work send`).
2. The agent runs `work hook turn-start`: pending review notes are handed
   over, the session is marked *working*, `work web` is nudged and pushes
   `sessions-changed` over SSE; the dashboard refetches.
3. The agent works. Its transcript and process files change; `work web`
   watches them, so the dashboard keeps up even without hooks.
4. The agent runs `work hook turn-end`: a checkpoint (a snapshot of the
   worktree) is taken for the **Last turn** diff, the session is marked
   *done*, and you're notified — in the focused tab, a browser notification,
   or a desktop toast, depending on where you're looking.
5. A permission prompt (`notify`) marks it *needs input*; the Inbox shows the
   exact request, and Allow / Deny types the answer only after checking the
   dialog on screen is that request.

## Security model

A local tool: its servers listen on `127.0.0.1`, check `Host` and `Origin`,
and the PTY host needs a per-run token. Commands run as argv arrays, never
shell strings. Anything posted to GitHub is in your name, so it happens only
on your yes ([ADR 0007](adr/0007-github-writes-on-yes.md)). See
[`SECURITY.md`](../SECURITY.md).
