# Demo mode (`work web --demo`)

`server/demo/scenario.ts` is an in-memory world (sessions, diffs as unified-diff text through the real parser, PRs, Jira, tasks, comments via the real in-memory comment store, a scripted timeline, simulated effects for answer / comment / ship / archive). `server/demo/demo-server.ts` serves it on the same routes and wire types (`core/api-types.ts`) as work web, including SSE and the terminal WebSocket framing, behind the same `local-server` Origin guard. It is the UI/logic separation check: `tests/architecture/demo-separation.test.ts` forbids `src/server/demo/` from importing any real-I/O module at runtime, and requires every dashboard route of the real server to exist in the demo; `e2e/demo.spec.ts` runs the real binary under an empty HOME and asserts nothing was written.

§ WHEN adding a dashboard API route, add it to `server/demo/demo-server.ts` too (the contract test fails otherwise), and put its wire type in `core/api-types.ts`.
