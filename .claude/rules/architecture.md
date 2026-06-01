# Architecture (§2)

> Project-specific architecture rules. Descriptive source: `.claude/references/architecture-principles.md`.

- **§2.1** [CONVENTION] Keep the command → core → utils dependency direction. `src/commands/*` may import from `src/core/*`; core MUST NOT import from `src/commands/*`. Evidence: `src/commands/list.ts:5-7`.
- **§2.2** [CONVENTION] One command per file: `src/commands/<verb>.ts` exporting `export const <verb>Command: CommandModule`, then registered in `src/cli.ts`. 14/14 commands follow this.
- **§2.3** [CONVENTION] React/Ink is the terminal UI renderer ONLY. WHEN adding UI, DO NOT reach for DOM/web APIs or browser-only libraries — Ink primitives render to the terminal. React imports belong under `src/tui-ink/` (`grep -rln "from 'ink'" src` → only `src/tui-ink/*`).
- **§2.4** [CONVENTION] `node-pty` is wrapped by `src/tui/session.ts` (the only importer). WHEN adding terminal-session behavior, go through the session layer rather than importing `node-pty` elsewhere.
- **§2.5** [ENFORCED] ESM with explicit `.js` extensions on relative imports (sources are `.ts`). WHEN adding an import of a local module, DO use the `.js` suffix — extensionless relative imports break at runtime under Node ESM. 136 `.js` imports, 0 extensionless.
- **§2.6** [CONVENTION] Use the `node:` prefix for Node builtins (`node:fs`, `node:path`, …).
