# Architecture decision records

One file per decision that shapes the codebase: the context, what was
decided, and what it costs. New ones take the next number; a decision that
is replaced keeps its file, marked *Superseded by NNNN*.

The first seven were written on 2026-10-03, after the fact, from the code,
its history and `CLAUDE.md`.

| # | Decision | Status |
|---|---|---|
| [0001](0001-sqlite-state.md) | Session state in one SQLite database | Accepted |
| [0002](0002-pty-host.md) | A PTY host owns every agent terminal | Accepted |
| [0003](0003-singleton-work-web.md) | One `work web` per user; `wd` registers on it | Accepted |
| [0004](0004-agent-adapters.md) | Agents behind an adapter interface | Accepted |
| [0005](0005-core-by-feature.md) | Core grouped by feature; the HTTP front-end in `src/server` | Accepted |
| [0006](0006-desktop-velopack.md) | The desktop app ships through Velopack with the CLI inside | Accepted |
| [0007](0007-github-writes-on-yes.md) | Nothing reaches GitHub without the user's yes | Accepted |

Template:

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
## Decision
## Consequences
```
