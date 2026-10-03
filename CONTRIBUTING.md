# Contributing

## Setup

Node 22 or newer (CI runs 22 and 24; `.nvmrc` pins the dev version), git, and
for the dashboard's GitHub and Jira features `gh` and `acli`.

```bash
npm ci
npm run build      # tsup → dist/ (CLI) and Vite → dist/web (dashboard)
npm link           # `work` and `wd` on your PATH, running this checkout
```

Rebuild after source changes (`npm run dev -- <args>` runs the CLI from source
through tsx). A running `work web` from an older build is replaced by the next
`work web`; the PTY host outlives rebuilds (`work pty-host --restart` after a
protocol change).

## Checks

All of these run in CI, and should pass before a PR:

| Command | What it checks |
|---|---|
| `npm run typecheck` | the CLI/server, the dashboard, and the tests + e2e specs |
| `npm run lint` | ESLint: correctness rules (unhandled promises, hook dependencies, …) |
| `npm run format:check` | Prettier (`npm run format` fixes it; editors pick up `.prettierrc.json`) |
| `npm test` | vitest; `npm run test:coverage` adds a coverage report (`coverage/`) |
| `npm run test:e2e` | Playwright against the built binary (the demo dashboard, the PTY host) |

Tests run with a throwaway HOME and git config, so they never touch your
`~/.work`, `~/.claude` or git identity.

## Where things go

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) first; the full reference
is [`CLAUDE.md`](CLAUDE.md), with the rules in [`.claude/rules/`](.claude/rules/).
The essentials:

- **Logic goes in `src/core/<feature>/`**, called by both front-ends: the CLI
  (`src/commands/`, one command per file) and the HTTP server
  (`src/server/routes/`). A command or route only parses input and formats
  output. Core never prints — it reports (`report()`).
- **Relative imports end in `.js`** (sources are `.ts`); `tsc` rejects them
  otherwise.
- **Every change has a test**, in the `tests/` folder mirroring the source.
  Build expensive fixtures (real git repos) once and copy them per test.
- **Subprocesses take argv arrays** (`cross-spawn`), never a shell string with
  a branch name or path in it.
- **State goes through `state.db`** (`core/platform/db.ts`), read-then-write in
  one `tx()`; per-session state is purged with the session.
- **A new dashboard route** needs its twin in the demo server
  (`src/server/demo/`) and its wire type in `core/api-types.ts`.
- **A new dependency the CLI or server imports** goes in `dependencies`; one
  only the dashboard uses is a `devDependency` (Vite bundles it). A test
  checks both.
- **The lockfile is `npm-shrinkwrap.json`** (not package-lock.json): npm
  publishes it, so a global install gets exactly the versions CI tested.

## Commits and PRs

- Branches: `feat/…`, `fix/…`, `docs/…`.
- Commit subjects are imperative and say what changed ("Archive saves
  uncommitted work"), no `type:` prefixes.
- PRs go to `main`. A user-facing change bumps `package.json`'s version.

## Releases

Publishing a GitHub Release whose tag matches `package.json` (`vX.Y.Z`) runs
`release.yml`: npm (trusted publishing, no token), the Homebrew tap, and the
desktop installers on the same release. Never `npm publish` locally. Note the
release in [`CHANGELOG.md`](CHANGELOG.md).
