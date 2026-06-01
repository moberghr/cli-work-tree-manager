# Security (§1)

> Shared checklist: `.claude/references/security-checklist.md`. This is a local dev CLI — the trust surface is the user's machine, git remotes, and spawned subprocesses.

- **§1.1** [CONVENTION] WHEN building a git/shell command, use `cross-spawn` with an argv array — DO NOT interpolate user/branch/path input into a shell string. Shell-string interpolation of branch names or repo paths is a command-injection vector.
- **§1.2** [CONVENTION] WHEN spawning subprocesses or PTY sessions, validate/normalize file-system paths (worktree roots, repo aliases) before use; never pass unresolved user input to `fs` or `node-pty` directly.
- **§1.3** [CONVENTION] The local diff/comment server (`src/core/comment-server.ts`) binds `node:http`. Keep it bound to localhost and short-lived; do not expose it on `0.0.0.0`.
- **§1.4** [ENFORCED] NEVER commit secrets, tokens, or absolute user-specific paths. State and logs belong under `~/.work/`, which is outside the repo.
