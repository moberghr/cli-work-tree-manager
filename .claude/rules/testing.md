# Testing (§4)

> Framework: Vitest. Supplement: `.claude/references/typescript/testing-supplement.md`.

- **§4.1** [ENFORCED] Run tests with `npm test` (`vitest run`). New behavior and bug fixes need a test.
- **§4.2** [CONVENTION] Tests live in `tests/` mirroring `src/` (`tests/commands`, `tests/core/<feature>`, `tests/server`) — NOT co-located. Name them `<module>.test.ts`.
- **§4.3** [CONVENTION] Use Vitest assertions (`expect(...).toBe(...)`) inside `describe` blocks; mock with `vi.mock` / `vi.fn`. Match the existing style (`tests/core/config.test.ts`).
- **§4.4** [CONVENTION] Core logic (`src/core/*`) is the priority for unit tests — it holds the worktree/git/state behavior. Command files are thin yargs wrappers.
- **§4.5** [ENFORCED] Every test file runs with its own temp HOME/USERPROFILE (`tests/setup/isolate-home.ts`; guarded by `tests/packaging/home-isolation.test.ts`), so no test can reach the real `~/.work` or `~/.claude`. Tests that mock `os.homedir()` still work; DO NOT point a test at `WORK_TEST_REAL_HOME`.
- **§4.6** [CONVENTION] WHEN a test starts real processes (PTY host, a tool, `work attach`), record their pids and sweep them with `killTree` in cleanup (`tests/functional/fixtures/processes.ts`, same as `e2e/fixtures.ts`), with each cleanup step isolated (`runAll`) so a failed test cannot leak processes that hold temp dirs open.
- **§4.7** [CONVENTION] Build expensive fixtures (real git repos) once in `beforeAll` and `fs.cpSync` them per test. Per-test `git init` + commit in `beforeEach` made one file 109 s of the suite.
