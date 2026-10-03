# 0005. Core grouped by feature; the HTTP front-end in `src/server`

- Status: Accepted
- Date: 2026-10-03

## Context

`src/core` had grown to 185 files in one folder, mixing domain logic, the
HTTP routes (25 `*-routes.ts`), infrastructure and the demo server. Some CLI
commands imported logic from route files — one front-end calling the other.

## Decision

- `src/core/<feature>/` holds the logic, one folder per feature (`sessions`,
  `status`, `rail`, `stacks`, `worktree`, `diff`, `comments`,
  `conversations`, `archive`, `cleanup`, `pr`, `jira`, `chat`, `pty`, `git`,
  `agents`) plus `platform/` for infrastructure. Only `api-types.ts` (the wire
  contract) and `tasks.ts` stay at its root.
- `src/server/` is the HTTP front-end: `web-server.ts`, `routes/`, `demo/`
  and what only it uses.
- `commands/` and `server/` call core; core imports neither. Among commands
  only `web.ts` and `diff.ts` import the server (they start one). Logic a
  command needs from a route moves into core.
- `tests/` mirrors `src/`.

## Consequences

- A feature's files are found together; the folders are not layers, so
  features import each other directly.
- The direction is enforced by architecture tests, as are "core and server
  never print".
- Files that locate shipped assets find the package root
  (`platform/package-root.ts`) instead of counting `..`.
