# 0002. A PTY host owns every agent terminal

- Status: Accepted
- Date: 2026 (2.0; recorded 2026-10-03)

## Context

The terminal dashboard of 1.x (`work dash`, Ink) owned the agent PTYs itself:
closing or rebuilding it killed every running agent. The browser dashboard
(`work web`) restarts often — on rebuilds, upgrades, a new build replacing
an old server — and a terminal you opened with `work tree` should show up in
the dashboard too.

## Decision

A separate, detached process — the PTY host (`work pty-host`, hidden) —
owns every agent PTY (`core/pty/pty-host.ts`, `pty-registry.ts`; node-pty
only in `core/pty/pty-session.ts`). It listens on `127.0.0.1` with a random
token per run (discovered through `~/.work/pty-host.json`). `work web`
(`core/pty/pty-pool.ts`) and `work attach` are clients; several may attach
to one PTY. Live sessions are mirrored to a restore list in `state.db`; when
the host starts, they are respawned with their conversation resumed.

## Consequences

- Restarting `work web` or closing a terminal only drops a view; agents keep
  working, and survive a reboot (restored with `--continue`).
- The host outlives rebuilds, so its wire format is versioned
  (`PROTOCOL_VERSION`); an old host is detected and `work pty-host --restart`
  is suggested rather than misbehaving.
- A busy host must never be mistaken for a missing one (a second host would
  restore every session again): a timed-out probe means busy.
- Idle agents nobody watches are put to sleep after a while
  (`idle-sleep.ts`), since the host would otherwise keep every one alive.
