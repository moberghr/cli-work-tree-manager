# State & Persistence (§5)

> This CLI has no database/ORM. "Data layer" = JSON state files under `~/.work/`.

- **§5.1** [ENFORCED] Persistent state lives in JSON under `~/.work/` via `getConfigDir()` (`src/core/config.ts:35`). DO NOT scatter state writes to other locations.
- **§5.2** [ENFORCED] Session state (history, status, comments, deliveries, PTY restore list, PR-watch keys, dev runs, tasks) lives in `~/.work/state.db` via `src/core/db.ts` — the only module that imports the SQLite engine (architecture test). WHEN reading-then-writing it, do it inside one `tx()`; never hold a transaction across an `await`. For files that stay files (config.json, settings.json edits) keep `withFileLock` + `atomicWriteFile` (`src/core/fs-safe.ts`).
- **§5.3** [ASPIRATIONAL] `config.json` is currently written with a bare `fs.writeFileSync` (`src/core/config.ts:71`), unlike history/tasks. Prefer migrating it to the atomic+lock path; do not add new bare writes for shared state. See architecture-principles §10.
- **§5.4** [CONVENTION] WHEN a lock target may not exist yet, call `ensureFile()` before `withFileLock` — proper-lockfile resolves the realpath before creating its sibling `.lock` dir (`src/core/fs-safe.ts:21`).
- **§5.5** [CONVENTION] WHEN adding per-session state, add a table keyed by `session_id` and delete from it in `purgeSessionRows` (`src/core/db.ts`), so removing a session removes it. Stored rows are parsed as `unknown` and shape-checked, never cast.
