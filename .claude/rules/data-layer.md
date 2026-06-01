# State & Persistence (§5)

> This CLI has no database/ORM. "Data layer" = JSON state files under `~/.work/`.

- **§5.1** [ENFORCED] Persistent state lives in JSON under `~/.work/` via `getConfigDir()` (`src/core/config.ts:35`). DO NOT scatter state writes to other locations.
- **§5.2** [CONVENTION] WHEN doing a read-modify-write on shared state, route it through `withFileLock` + `atomicWriteFile` (`src/core/fs-safe.ts`) so concurrent `work` processes can't corrupt or truncate the file. `history.ts` and `tasks.ts` follow this.
- **§5.3** [ASPIRATIONAL] `config.json` is currently written with a bare `fs.writeFileSync` (`src/core/config.ts:71`), unlike history/tasks. Prefer migrating it to the atomic+lock path; do not add new bare writes for shared state. See architecture-principles §10.
- **§5.4** [CONVENTION] WHEN a lock target may not exist yet, call `ensureFile()` before `withFileLock` — proper-lockfile resolves the realpath before creating its sibling `.lock` dir (`src/core/fs-safe.ts:21`).
