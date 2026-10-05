# Plan: Session state in SQLite

**Status: done, on `feat/pty-host`** (the user asked for it in the same PR). What shipped differs from the plan below in these ways:

- **Rows hold records as JSON** beside the key columns (`sessions(id, target, branch, data)`, `comments(store, id, data)`, …) instead of one column per field. The code already worked with whole records (a session, a status, a comment), so this kept every public API and all existing tests unchanged, while still giving transactions, per-row writes and one place to delete a session. Columns can be split out later where a query needs them.
- **No foreign keys.** Tests and some paths record deliveries, status or PTY entries for ids with no `sessions` row, which foreign keys would reject. `purgeSessionRows` (db.ts) deletes a session's rows from every table in one transaction instead.
- **Deliveries are a table** (`comment_deliveries(session_id, comment_id)`), not a `delivered_at` column: delivery is tracked per session while comments can come from a `wd` scope store, same as the old `<id>.delivered.json`. The claim is `INSERT OR IGNORE` in one transaction.
- **`work state [--export <dir>]`** instead of `work debug state`.
- **`open()` retries on SQLITE_BUSY**: switching a brand-new file to WAL while other processes do the same fails at once without honouring the busy timeout (caught by the four-process first-start test).
- **Tests use `WORK_DB_EPHEMERAL=1`** (open/close per call) so temp HOMEs can be deleted on Windows.
- **CI `package` job**: tarball installed globally on Windows/macOS/Linux × Node 22/24, then `work todo` against a fresh HOME.

## Why

`~/.work` holds under 300 KB of real state (22 MB total, 17 MB of it old `wd --static` pages, now swept). Size is not the problem. Concurrency and bookkeeping are:

- **Many writers.** The CLI, one `work hook` process per Claude event, `work web` and the PTY host all write `~/.work`. Today that is 11 modules doing read-modify-write through `withFileLock` and 18 modules writing state with a bare `writeFileSync` / `atomicWriteFile`. Each new file is a new chance to miss the lock. Found so far: the "concurrent history wipe", and `markDelivered` racing between the hook and the PTY push (fixed in `c678050` with a claim).
- **Scattered per-session state.** Status, comments, delivered markers, PTY-restore entries, dev-server runs and PR-watch keys are separate files. Deleting a session cleans up only what `sessionStatePaths` remembers to list.
- **Whole-file work on hot paths.** `history.json` is 116 KB / 367 sessions, read at 24 call sites, and parsed in full on every Claude hook event (`findSessionForCwd`).

## Scope

**Moves to `~/.work/state.db`:** history, session status, comments + delivered markers, PTY-restore entries (`pty-sessions.json`), PR-watch seen keys, dev-server runs, tasks.

**Stays as files:**
- `config.json`: edited by hand and documented as such.
- `web.url`, `web.pid`, `pty-host.json`: tiny discovery files with one writer, read by scripts and by processes that must not depend on the DB opening.
- Logs (`debug.log`, `pty-host.log`, `dev/<id>.log`): append-only text.
- `diffs/`: checkpoint manifests belong with their git refs (`refs/wd/<hash>/*`); static pages are artifacts.

## Engine

`better-sqlite3`: synchronous (fits the sync comment store and hook paths), mature, with prebuilt binaries for win32/darwin/linux on x64 and arm64. We already ship one native module (`node-pty`), so the install path is not new. Add it to tsup `external` (§9.3).

`node:sqlite` would avoid the native build, but on our Node 22 floor it is still experimental and prints an `ExperimentalWarning` (noise on hook stderr), and its API may change. Revisit when the floor moves to a Node where it is stable. `core/db.ts` keeps the engine behind one small interface so that switch is a single file.

## Schema (v1)

```sql
PRAGMA journal_mode = WAL;        -- readers never block the writer
PRAGMA busy_timeout = 5000;       -- replaces our proper-lockfile retries
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version, migrated_at

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,          -- sessionIdFor(target, branch)
  target          TEXT NOT NULL,
  branch          TEXT NOT NULL,
  is_group        INTEGER NOT NULL,
  base_branch     TEXT,
  jira_key        TEXT,
  port            INTEGER,
  created_at      TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  archived_at     TEXT,
  UNIQUE (target, branch)
);
CREATE TABLE session_paths (                 -- replaces paths[] and baseBranches{}
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ord         INTEGER NOT NULL,
  path        TEXT NOT NULL,                 -- as recorded
  path_key    TEXT NOT NULL,                 -- normalized, for cwd lookup
  base_branch TEXT,
  PRIMARY KEY (session_id, ord)
);
CREATE INDEX session_paths_key ON session_paths(path_key);

CREATE TABLE session_status (                -- replaces status/<id>.json
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL, prev_state TEXT, since TEXT NOT NULL,
  summary TEXT, seen INTEGER NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE comments (                      -- replaces comments/<store>.json
  id TEXT PRIMARY KEY,
  store TEXT NOT NULL,                       -- session id, or scope-<hash> for wd reviews
  repo TEXT NOT NULL, file TEXT NOT NULL, line INTEGER NOT NULL, side TEXT NOT NULL,
  body TEXT NOT NULL, author TEXT NOT NULL, status TEXT NOT NULL,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  line_content TEXT, resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT                          -- replaces <id>.delivered.json
);
CREATE INDEX comments_store ON comments(store, created_at);
CREATE INDEX comments_pending ON comments(store) WHERE delivered_at IS NULL AND status = 'published' AND author = 'user';

CREATE TABLE pty_sessions (                  -- replaces pty-sessions.json
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  spec TEXT NOT NULL                         -- JSON: cwd, tool, port, args
);

CREATE TABLE pr_watch_seen (                 -- replaces pr-watch/<id>.json
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE dev_runs (                      -- replaces dev/<id>.json
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  pid INTEGER NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL,
  created_at TEXT NOT NULL, done_at TEXT, link TEXT
);
```

Notes:
- **Comments are keyed by store, not session.** `wd` reviews live in `scope-<hash>` stores that belong to no session, so `comments` has no foreign key to `sessions`. Removing a session deletes `WHERE store = <id>` in the same transaction. That is the one delete a cascade can't cover.
- **Delivery becomes one statement:** `UPDATE comments SET delivered_at = ? WHERE id IN (…) AND delivered_at IS NULL RETURNING id`. The rows it returns are the claim, replacing `claimForDelivery`'s lock plus file rewrite.
- **Session delete becomes `DELETE FROM sessions WHERE id = ?`.** Everything else cascades. `sessionStatePaths` goes away (the dev log file stays on it).
- **`findSessionForCwd`** becomes an indexed lookup over `path_key` (prefix match for group roots and sub-repos) instead of parsing all of history.

## Module layout

- `core/db.ts`: `openDb()` (lazy, one per process, `~/.work/state.db`), `migrate()` (numbered SQL steps; `meta.schema_version`), `tx(fn)`. The only file that imports the engine. Add an architecture test that enforces this, like `node-pty` → `tui/session.ts`.
- Keep the existing module APIs (`loadHistory`, `upsertSession`, `getCommentFileStore`, `recordStatusEvent`, `claimForDelivery`, `createSeenStores`, …) and swap their bodies to queries. Callers and the 24 `loadHistory()` sites don't change in this PR. Narrowing them to targeted queries comes later, where it pays.
- `withFileLock` stays for the files that remain (settings.json edits, config).

## Migration

1. On first `openDb()` with no `meta.schema_version`: create the schema, then import every JSON source in one transaction. Rows that fail to parse are skipped and logged, never fatal, the same as today's corrupt-file backups.
2. Rename the imported files to `*.migrated` (not deleted) and record `meta.migrated_at`.
3. Guard against two processes migrating at once with `BEGIN IMMEDIATE` plus a re-check of `schema_version` inside the transaction.
4. **Rollback:** a `work debug state --export-json` command writes the old JSON shapes back from the DB. Combined with the `.migrated` copies, downgrading is: stop `work web` and the PTY host, export, reinstall the old version.
5. **Mixed versions** (the PTY host outlives upgrades): the host writes `pty_sessions`, so bump `PROTOCOL_VERSION`. An old host then tells the user to `work pty-host --restart` instead of writing a JSON file nobody reads.

## Tests

- Every existing state test keeps passing unchanged against the DB bodies. The public APIs don't move, so the tests are the regression suite.
- Migration: fixture `~/.work` trees (including the real shapes from a machine with 367 sessions, anonymized) → import → the same API results before and after.
- Concurrency: port the four-process claim race from `pending-delivery.test.ts`, and add the same race for `upsertSession` and `recordStatusEvent`.
- Cascade: delete a session, assert every table is clean and scope comment stores are untouched.
- Architecture: only `core/db.ts` imports the engine; the demo (`core/demo/`) still imports no DB module.
- Packaging: `npm pack` + install into a clean prefix on Windows, macOS and Linux CI runners, and open a DB (native binary present).

## Batches

1. `core/db.ts` + schema + migration framework + architecture test. Nothing uses it yet.
2. History and session paths (largest blast radius; hooks read it on every event).
3. Status, comments + delivery, PR-watch seen keys, dev runs.
4. PTY-restore entries (with the `PROTOCOL_VERSION` bump), tasks.
5. JSON import on first run, `.migrated` rename, `work debug state` (inspect + export), docs.

Each batch ends with `npx tsc --noEmit`, `npm test`, and `npm run build` + e2e.

## Risks

- **Native install fails** on some machine (no prebuild, locked-down proxy). Mitigation: CI packaging job per OS, and a clear error pointing to `npm rebuild better-sqlite3`. Fallback option: `node:sqlite` behind the same `core/db.ts` interface.
- **Antivirus or indexers on Windows** holding `state.db-wal`. WAL tolerates readers; `busy_timeout` covers short holds.
- **Hand-debugging gets harder.** `work debug state` prints sessions, status and pending comments in readable form.
- **Hook latency.** Opening the DB plus one indexed query is about a millisecond, cheaper than parsing 116 KB of JSON per event today. Measure it in batch 2.
