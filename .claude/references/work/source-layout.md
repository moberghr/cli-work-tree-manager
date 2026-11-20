# Source layout

```
src/
  bin.ts → cli.ts           the `work` binary: yargs router → commands/<verb>.ts
  wd-bin.ts                 the `wd` shim: forwards argv to commands/diff.ts
  install-skills-bin.ts     npm's postinstall (core/agents/skills.ts), never the whole CLI
  commands/                 CLI front-end: one command per file; parse input, call core, print
  server/                   HTTP front-end (work web): web-server.ts wires everything
    routes/                 one *-routes.ts per area (Hono sub-apps): parse, call core, answer
    demo/                   `work web --demo`: the same routes over a simulated world
    diff-server.ts, comment-server.ts, local-server.ts, local-origin.ts,
    spa-handler.ts, terminal-ws.ts, presence.ts, loop-watch.ts, shared-fetch.ts
  core/                     every piece of logic, by feature — both front-ends call it
    api-types.ts            the wire types every front-end shares (SPA included)
    tasks.ts                `work todo`
    agents/                 the agent interface (types.ts), the registry (index.ts), the
                            Ctrl+K assistant, skills, group instructions;
      claude/               everything Claude Code's (only index.ts imports it)
    sessions/               identity + store (history, session-id, session-types, session-store),
                            the wire row (session-wire, session-view, session-meta), activity,
                            live agents, session control/start, fork, saved prompts, fleet
    status/                 the attention inbox: session-status, attention, status hooks, notifier
    rail/                   pins and sections, order, snooze, blocked-by, notes
    stacks/                 stacked sessions, behind-main, update from main / parent
    worktree/               create / remove worktrees, resolve targets, setup child, dev server, ports
    diff/                   diff parse/pipeline/scope/stat, checkpoints (+ runInternal), scopes,
                            revert, lcov, overlap, static renderer
    comments/               comment model + file store, delivery to agents, broadcast
    conversations/          JSON-lines reading, the conversation store, context usage, title,
                            catch-up, Today digest, timeline, work time
    archive/                archive + restore, uncommitted saves, retention, search, summaries
    cleanup/                what can go (worktrees, build folders, merged branches)
    move/                   moving to another computer: the export bundle and its import
    hosts/                  git hosts (GitHost: types.ts), the registry (index.ts: a repo's host from its origin);
      github/               everything GitHub's: gh, its URLs, its GraphQL (only the registry imports it)
    pr/                     PRs, review threads + reply drafts, the PR watch, ship — through the repo's host
    review/                 PR reviews prepared in the background: kinds of change, tests, stories, the queue
    jira/                   acli issues, the Jira watch, worklogs, the board
    pty/                    the PTY host (server, registry, client, protocol), the pool, idle sleep;
                            pty-session.ts: PtySession (node-pty + @xterm/headless), the PTY host's only
    git/                    git wrapper, HEAD reading, base specs
    platform/               infrastructure: db (state.db), config, fs-safe, fs-watcher, settings
                            editor, hook installer, logger, report, process, web discovery,
                            build stamp, autostart, internal-run marker, the Activity log,
                            package root, work's own binary (work-bin), launching editors/URLs (launch)
  completions/              shell completions
  web/src/                  the React SPA (Vite → dist/web): apps/, components/, state/, hooks/
tests/                      mirrors src/ (tests/core/<feature>/, tests/server/, tests/commands/, …)
```

§ Dependency direction: `commands/` and `server/` call `core/`; core never imports either (architecture tests). Among commands, only `web.ts` (starts work web) and `diff.ts` (the foreground `wd -c` server) import `src/server`; logic a command needs from a route lives in core (`*-deps.ts`, `session-start.ts`). Within core, a feature imports another's module directly — the folders group by feature, they are not layers.
§ WHEN adding a module, put it in the feature folder it belongs to (a new folder for a new feature, not core's root); routes go in `src/server/routes/`, and their test in the mirrored `tests/` folder.
