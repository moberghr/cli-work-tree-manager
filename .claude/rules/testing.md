# Testing (§4)

> Framework: Vitest. Supplement: `.claude/references/typescript/testing-supplement.md`.

- **§4.1** [ENFORCED] Run tests with `npm test` (`vitest run`). New behavior and bug fixes need a test.
- **§4.2** [CONVENTION] Tests live in `tests/` mirroring `src/` (`tests/commands`, `tests/core`, `tests/tui`) — NOT co-located. Name them `<module>.test.ts`.
- **§4.3** [CONVENTION] Use Vitest assertions (`expect(...).toBe(...)`) inside `describe` blocks; mock with `vi.mock` / `vi.fn`. Match the existing style (`tests/core/config.test.ts`).
- **§4.4** [CONVENTION] Core logic (`src/core/*`) is the priority for unit tests — it holds the worktree/git/state behavior. Command files are thin yargs wrappers.
