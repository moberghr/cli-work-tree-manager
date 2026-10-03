# 0003. One `work web` per user; `wd` registers on it

- Status: Accepted
- Date: 2026 (recorded 2026-10-03)

## Context

`wd` (the diff viewer) used to start a server of its own per scope, with its
own pid, url and log files: every `wd` in another worktree was another
process and another port, and the dashboard and the diffs couldn't share
anything — comments, checkpoints, live updates.

## Decision

`work web` is a singleton per user, found through `~/.work/web.url` and
`web.pid`. `wd` registers a scope on it (`POST /api/scopes`) and opens
`/diff/<hash>`; when none is running, `wd` starts one in the background in
*lean* mode (no dashboard watchers; of the hooks, only the per-turn
checkpoint). A full `work web`
replaces a running server of a different build (`/api/context` carries a
build stamp). Two that start at once resolve it themselves: every 20 s the
one `web.pid` doesn't name steps aside.

## Consequences

- One process and one port for every diff and the dashboard; scopes,
  comments and checkpoints are shared.
- PIDs get reused, so stopping checks the recorded pid answers as work web
  before killing anything.
- A server that outlived a rebuild serves old routes; replacing it by build
  stamp is required, not optional.
