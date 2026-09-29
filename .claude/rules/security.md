# Security (§1)

> Shared checklist: `.claude/references/security-checklist.md`. This is a local dev CLI — the trust surface is the user's machine, git remotes, and spawned subprocesses.

- **§1.1** [CONVENTION] WHEN building a git/shell command, use `cross-spawn` with an argv array — DO NOT interpolate user/branch/path input into a shell string. Shell-string interpolation of branch names or repo paths is a command-injection vector.
- **§1.2** [CONVENTION] WHEN spawning subprocesses or PTY sessions, validate/normalize file-system paths (worktree roots, repo aliases) before use; never pass unresolved user input to `fs` or `node-pty` directly.
- **§1.3** [CONVENTION] The local diff/comment server (`src/core/comment-server.ts`) binds `node:http`. Keep it bound to localhost and short-lived; do not expose it on `0.0.0.0`.
- **§1.4** [ENFORCED] NEVER commit secrets, tokens, or absolute user-specific paths. State and logs belong under `~/.work/`, which is outside the repo.
- **§1.5** [ENFORCED] Every local server goes through `refuseReason` (`src/core/local-origin.ts`): Host must be ours, cross-site requests are refused except a top-level page load (GET/HEAD, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`), and mutating requests / WebSocket upgrades need no Origin or our own. WHEN adding a GET route, keep it free of side effects that matter — a page on another site can make the browser open it.
- **§1.6** [CONVENTION] WHEN acting on a remembered pid (kill, "is it running"), check it is still ours: same boot (`bootTime()`) and, before killing, the same executable (`processName`). Pids are reused, fast on Windows.
