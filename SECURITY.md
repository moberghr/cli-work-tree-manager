# Security

## Reporting a vulnerability

Please don't open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
(private vulnerability reporting). Include what you found, how to reproduce
it, and the version (`work --version`). You'll get an answer within a few
working days.

Fixes go into the latest release; there are no backports to older versions.

## What `work` does to stay safe

`work` is a local developer tool. What it guards against is a web page in
your browser, a hostile text the agent reads, or another local process, using
`work`'s servers or its agents to act for you.

- **Local servers only.** `work web`, `wd` and the PTY host listen on
  `127.0.0.1`. Every request's `Host` must be ours; cross-site requests are
  refused, and requests that change something (and WebSocket upgrades) need
  our own `Origin` or none. GET routes have no side effects that matter.
- **The PTY host needs a token** generated per run and kept in
  `~/.work/pty-host.json`; it controls the agents' terminals.
- **No shell strings.** Git, `gh` and every subprocess take argv arrays;
  branch names and paths are never interpolated into a shell command. On
  Windows, agent commands are built without `cmd.exe /c`.
- **Agents act on your say-so.** Commands that make another session act or
  approve its tool calls (`work send`, `start`, `stop`, `answer`) and posting
  on GitHub (`work pr post`) are never pre-allowed for an agent; the
  dashboard's Allow types an answer only after checking the dialog on screen
  is the request you saw. Review text from people without write access never
  reaches an agent. See [ADR 0007](docs/adr/0007-github-writes-on-yes.md).
- **Untrusted text has no tools.** work's own internal agent runs (checkpoint
  names, summaries, the Jira watch) run without tools, in a neutral folder,
  without your MCP servers.
- **Secrets stay out of state.** Environment variables kept for restored
  sessions (`hostEnv`) never include names or values that look like secrets;
  the Jira API token is never sent to the dashboard.
- **Dependencies.** CI fails on a known high or critical advisory in what a
  global install gets (`npm audit --omit=dev`); Dependabot proposes updates
  weekly.
