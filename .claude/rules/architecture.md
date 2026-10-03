# Architecture (§2)

> Project-specific architecture rules. Descriptive source: `.claude/references/architecture-principles.md`.

- **§2.1** [ENFORCED] Two front-ends over one core: `src/commands/*` (CLI) and `src/server/*` (HTTP, routes in `src/server/routes/`) import `src/core/*`; core MUST NOT import either. Among commands only `web.ts` and `diff.ts` import `src/server` (they start servers); logic a command needs from a route belongs in core. Enforced by `tests/architecture/boundaries.test.ts`.
- **§2.2** [CONVENTION] One command per file: `src/commands/<verb>.ts` exporting `export const <verb>Command: CommandModule`, then registered in `src/cli.ts`. 14/14 commands follow this.
- **§2.3** [ENFORCED] React belongs to the browser SPA under `src/web/` only; nothing imports Ink (the `work dash` terminal UI was retired in 2.0). Node-side code never imports React. Enforced by `tests/architecture/boundaries.test.ts`.
- **§2.4** [ENFORCED] `node-pty` is wrapped by `src/tui/session.ts` (the only importer), and session PTYs are created only by the PTY host (`core/pty/pty-registry.ts`). WHEN adding terminal-session behavior, go through the host rather than constructing `PtySession` elsewhere.
- **§2.5** [ENFORCED] ESM with explicit `.js` extensions on relative imports (sources are `.ts`). WHEN adding an import of a local module, DO use the `.js` suffix — extensionless relative imports break at runtime under Node ESM. 136 `.js` imports, 0 extensionless.
- **§2.6** [CONVENTION] Use the `node:` prefix for Node builtins (`node:fs`, `node:path`, …).
- **§2.7** [ENFORCED] Core and the server never print: no `chalk`, `console.*` or stdout/stderr writes under `src/core` or `src/server` (`platform/logger.ts` excepted). Report with `report(level, text)` (`core/platform/report.ts`); front-ends decide how to show it. WHEN adding behavior, implement it in core and keep CLI commands and API routes as thin front-ends over the same function. Enforced by `tests/architecture/boundaries.test.ts`.
- **§2.8** [CONVENTION] `src/core` is grouped by feature (`sessions/`, `status/`, `diff/`, `pr/`, `pty/`, `platform/`, …; CLAUDE.md "Source layout"), not by layer. WHEN adding a module, put it in its feature's folder — never core's root (only `api-types.ts` and `tasks.ts` live there) — and its test in the mirrored `tests/` folder.
