# 0001. Session state in one SQLite database

- Status: Accepted
- Date: 2026-09-30 (recorded 2026-10-03)

## Context

Session state lived in JSON files under `~/.work/` (history, status,
comments, deliveries, the PTY restore list, …), each guarded by a file lock
and written atomically. Many processes write it at once — the CLI, every
agent's hooks (several per turn, for every running agent), `work web` and the
PTY host — and read-modify-write across files lost updates; the dashboard
also polled and parsed whole files to notice changes. The plan is in
`docs/plans/2026-09-30-sqlite-state.md`.

## Decision

One SQLite database, `~/.work/state.db` (WAL), opened only by
`core/platform/db.ts` (`better-sqlite3`). Each record is stored as JSON next to
the columns it is looked up by; read-then-write happens in one `tx()`.
Triggers bump change counters (`rev:sessions`, `rev:tasks`, `rev:rail`) that
`work web` polls once a second instead of watching files. The first open
imports the old JSON files in the same transaction and renames them
`*.migrated`; `work state --export` writes the database back in the old
layout. `config.json` stays a file.

## Consequences

- Concurrent writers no longer lose updates; one transaction covers a
  read-then-write.
- A native module ships with the package (prebuilt per platform; the CI
  package job checks it loads on every OS and Node version).
- Every per-session table must be purged with the session (`purgeSessionRows`).
- A transaction can't span an `await`: async work is done outside and
  re-checked inside.
- Tests need an isolated HOME and `WORK_DB_EPHEMERAL=1` so connections close.
