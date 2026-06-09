# Project-Specific (§9)

- **§9.1** [CONVENTION] Two binaries ship from this package: `work` (`src/bin.ts` → `src/cli.ts`) and `wd` (`src/wd-bin.ts`, the diff viewer). Changes to CLI wiring may need both entry points.
- **§9.3** [ENFORCED] Build with `tsup` (`npm run build`); dev-run with `tsx` (`npm run dev`). Runtime deps are externalized in `tsup.config.ts` — WHEN adding a runtime dependency that must not be bundled, add it to the `external` list.
- **§9.4** [CONVENTION] Generated `CLAUDE.md` files for managed worktrees are produced by `src/core/claude-md.ts` — do not confuse those with THIS repo's root `CLAUDE.md`.
- **§9.5** [CONVENTION] Global error handling in `src/bin.ts` intentionally swallows node-pty "already exited" errors and inquirer `ExitPromptError`. Preserve that behavior when touching startup/shutdown.
