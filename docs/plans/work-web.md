# `work web` — Browser Dashboard

Status: **Planning** · Owner: TBD · Tracker tag: `work-web`

A long-running local web server that surfaces every worktree session in one browser tab. Mirrors `work dash` (the TUI) but visual, with the per-session diff review experience from `wd -c` and an embedded terminal that talks to each session's Claude PTY.

---

## Goals

- **Single tab, every session.** Sidebar lists all worktrees from `~/.work/history.json`. Click one to inspect.
- **Live diff per session.** Same renderer and review UX as `wd -c`, scoped to the selected session. Drafts persist across server restarts.
- **Embedded Claude PTY.** Selecting a session's terminal tab gives you a real, interactive xterm.js view of that session's running Claude Code process.
- **Live everything.** New worktree elsewhere → it shows up. Save a file → its diff updates. Claude emits output → terminal scrolls.
- **Coexists with `work dash`.** Different front end on the same `~/.work/` data; you can run both at once. The TUI stays for keyboard-first workflows.

## Non-goals (V1)

- PR / Jira / Tasks panes — V2.
- Worktree mutation from the web (create / remove / resume) — V3.
- Embedded PTY persistence across `work web` restarts. PTYs survive *browser* disconnects, but not server kills.
- Multi-user, auth, network access. Bound to `127.0.0.1` only.
- Mobile-first design. Desktop browser only.

## User flows

1. **Open the dashboard.** `work web` from anywhere → opens browser at `http://127.0.0.1:<port>/` → SPA loads → sidebar populated with sessions.
2. **Inspect a session's diff.** Click session → main pane defaults to **Diff** tab → live `wd`-style diff for that worktree. Click a line → leave a comment / draft. Submit a review batch. Same UX as `wd -c`.
3. **Talk to a session's Claude.** Switch to the **Terminal** tab → xterm.js renders the live PTY → type a prompt → Claude responds → switch tabs freely, the PTY keeps going.
4. **Discover new work.** Start `work tree somerepo feature/x` in another shell → the sidebar gains the new session within ~1s. Highlight badge until you open it.
5. **Survive restarts.** Kill `work web` (`Ctrl+C`). Re-run. Your drafts are still there, comments still there. The Claude PTY is **not** — the process was tied to `work web`'s lifetime. (See V2/V3 thinking below.)

## Architecture

```
Browser
  React SPA
    ├── api/  (REST + SSE client)
    ├── state/ (sessions, comments, current selection)
    └── components/
        ├── Sidebar/SessionList
        ├── Diff/DiffView           (port of diff-html.ts to React)
        ├── Terminal/PtyView        (xterm.js + WebSocket)
        └── Modal/Composer/etc.
  ↑
  │ HTTP + SSE + WebSocket
  ↓
work web (long-running daemon)
  ├── http server  (REST + SSE + static SPA)
  ├── ws server    (one connection per active terminal)
  ├── core/web-state.ts
  │   ├── reads ~/.work/history.json (watched)
  │   ├── per-session diff watcher (chokidar, lazy)
  │   └── per-session pty (node-pty, lazy)
  └── core/comment-store.ts
      └── ~/.work/comments/<session-id>.json (persistent)
```

## Data model

### Session

Sourced from `core/history.ts` (existing). Each `WorktreeSession` already carries `target`, `branch`, `paths`, `baseBranch`, `lastAccessedAt`. We compute one extra value:

- `sessionId = sha1(target + ':' + branch).slice(0, 12)` — stable across reboots, identical for the same worktree even across new server processes. Used as the URL slug, the comments file name, the WS connection key.

The browser-side `Session` adds derived fields the server computes:

- `unreadCount` — comments added since the user last opened this session (server tracks `lastViewedAt` per browser? or just per session). Initial v1: count of comments authored by *claude* the user hasn't seen yet.
- `pendingDraftCount` — drafts in comments.json
- `status` — `running` if the PTY is alive, `idle` otherwise

### SessionComment

Same shape as the existing `Comment` from `comment-server.ts` (id, repo, file, line, side, body, author, parentId, status, lineContent, createdAt). Scoped per session via the path `~/.work/comments/<sessionId>.json`.

The existing `comment-server.ts` is **per-process, in-memory**. `work web` flips this to **file-backed**. Migration plan below.

## File layout

```
src/
  commands/
    web.ts                    ← new: `work web` command entry
  core/
    web-server.ts             ← new: HTTP + SSE server, wires everything
    web-ws.ts                 ← new: WebSocket bridge for PTY
    web-state.ts              ← new: session aggregation, diff cache, PTY pool
    comment-store.ts          ← new: per-session persistent comment storage
    history.ts                (unchanged, source of truth for sessions)
    diff-parse.ts             (unchanged)
    diff-pipeline.ts          (unchanged)
    (diff-html.ts deprecated for web mode — replaced by React renderer)
  web/                        ← new directory, React app source
    index.html
    vite.config.ts
    tsconfig.json             (separate from server tsconfig)
    src/
      main.tsx
      App.tsx
      api/
        client.ts             ← typed fetch wrappers
        events.ts             ← SSE subscription hook
        terminal.ts           ← WebSocket connection per terminal
      state/
        sessions.ts           ← Context + reducer
        comments.ts
        selected.ts
      components/
        Sidebar/
          SessionList.tsx
          SessionRow.tsx
        Diff/
          DiffView.tsx
          FileTree.tsx
          DiffFile.tsx
          DiffRow.tsx
        Comments/
          CommentList.tsx
          CommentItem.tsx
          Composer.tsx
          ReplyComposer.tsx
          PendingPill.tsx
          SubmitReviewModal.tsx
        Terminal/
          PtyView.tsx
          PtyTab.tsx
        Layout/
          Tabs.tsx
          Modal.tsx
      styles/
        tokens.css            ← CSS variables (light/dark)
        diff.css
        sidebar.css
        comments.css
        terminal.css
dist/
  bin.js                      (work)
  wd-bin.js                   (wd)
  web/                        ← Vite output, served by web-server.ts
    index.html
    assets/
      main-<hash>.js
      main-<hash>.css
```

## Build

Two toolchains in one repo:

- **tsup** (already): bundles all Node code (`bin.ts`, `wd-bin.ts`, commands, core) as ESM with externals.
- **Vite** (new): bundles the React app to `dist/web/`. Production build only — no dev server needed since `work web` always serves the built bundle.

Top-level `npm run build` runs both. `npm run dev` runs tsup watch + Vite dev mode side-by-side (for the future; not required for V1).

## Server: HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | SPA shell (`dist/web/index.html`) |
| GET | `/assets/*` | Vite-built JS/CSS |
| GET | `/api/sessions` | `[]` of session summaries |
| GET | `/api/sessions/:id` | full session details + path resolution |
| GET | `/api/sessions/:id/diff` | `ParsedFile[]` for the session's working-tree diff vs HEAD |
| GET | `/api/sessions/:id/comments` | `Comment[]` for that session |
| POST | `/api/sessions/:id/comments` | add a comment (body: { repo, file, line, side, body, status, parentId, author, lineContent }) |
| DELETE | `/api/sessions/:id/comments/:cid` | delete one |
| POST | `/api/sessions/:id/submit-review` | flip all drafts → published, optional summary |
| POST | `/api/sessions/:id/discard-review` | delete all drafts |
| GET | `/events` | SSE: global stream |

## Server: WebSocket

```
WS /ws/sessions/:id/terminal
```

- Opens (or attaches to) the session's `PtySession`.
- Binary frame: PTY → browser bytes (xterm.js writes them).
- Text JSON frame from browser: `{ type: 'input', data }` → write to PTY; `{ type: 'resize', cols, rows }` → resize the PTY.
- Server keeps the PTY alive even when the WS disconnects (browser tab close, network blip). The next reconnect re-attaches to the same PTY.

## SSE event types

Topic-prefixed `event:` lines, JSON payloads:

- `sessions-changed` — history.json updated. Payload: `{ added, removed, updated }` session-id arrays. Client re-fetches `/api/sessions`.
- `diff-changed` — payload: `{ sessionId }`. Client re-fetches diff if this is the focused session.
- `comments-changed` — payload: `{ sessionId, kind: 'added' | 'deleted' | 'submitted', count? }`. Client re-fetches comments for that session.
- `pty-status` — payload: `{ sessionId, status: 'started' | 'exited' }`.

Same suppression rule as `wd -c`: SSE only fires for changes that came from somewhere **other** than the requesting client (i.e. another tab, another machine, or Claude via API). The browser tracks its own ops and ignores echoes via the comment server's existing convention.

## Lifecycle

Per session, the server holds at most three live resources:

1. **Diff watcher** — chokidar on the session's repo roots. Started when the session is first opened in any browser; stopped after N minutes of zero browsers having that session selected.
2. **Comment store** — loaded on first access, written through to disk on every mutation.
3. **PTY** — spawned when the Terminal tab is opened, kept alive for the lifetime of `work web` (or explicit `kill PTY` action — V3).

Cap on watcher count: 8 concurrent. LRU eviction when exceeded. (Tunable.)

## Persistence

- **Sessions**: read-only from `~/.work/history.json`. We don't write back; `work tree` / `work remove` still own that file.
- **Comments**: `~/.work/comments/<sessionId>.json`. Atomic write (tmp + rename). One file per session keeps lock contention low and makes manual inspection easy.
- **Per-browser state** (active tab, scroll position, viewed checkboxes): browser `localStorage` keyed by `sessionId`. Survives reload but not different machines — acceptable.
- **PTY scrollback / Claude history**: not persisted by us. Claude has `--continue` semantics handled by `tui/session.ts`; we reuse that.

## Phasing (V1 internal milestones)

| # | Milestone | What works | Estimate |
|---|---|---|---|
| 1 | **Skeleton** | `work web` boots, opens browser, blank SPA, `/api/sessions` returns the list, sidebar renders names + base branch. Click does nothing. | 0.5–1 session |
| 2 | **Diff view** | Click session → diff renders in main pane. Live updates via chokidar + SSE. No comments yet. | 1–2 sessions |
| 3 | **Comments + drafts + submit** | Full `wd -c` review UX, but per-session in the dashboard. Persistent to disk. | 2 sessions |
| 4 | **Terminal** | PTY pool, WS bridge, xterm.js client. Type prompt → Claude responds. Resize works. | 1–2 sessions |
| 5 | **Polish** | Status badges, search/filter in sidebar, keyboard shortcuts, sensible defaults. | 1 session |

Total: 5–7 focused sessions.

## Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Framework | React | Matches Ink in the TUI, ecosystem fit for xterm.js/router/state libs, bundle size irrelevant for localhost |
| Bundler (client) | Vite | Standard for React, fast dev cycle, simple production output |
| State mgmt | Context + reducer | Sufficient for V1. Zustand if/when it gets gnarly. |
| Routing | URL hash (`#/sessions/<id>`) | Simpler than HTML5 history, no server-side routing config |
| CSS | CSS Modules + a `tokens.css` design-token file | Familiar, avoids Tailwind in this codebase, themable |
| Auth | None (127.0.0.1 only) | Local dev tool |
| Port | New random port per launch, written to `~/.work/web.url` | Same pattern as `wd -c`'s `latest-review.url` |

## Risks / open questions

- **Reusing `wd -c`'s comment-server.ts logic vs writing fresh.** The existing server is in-memory + per-process. `work web` needs per-session, file-backed, multi-tab broadcasting. We'll write a new module (`comment-store.ts`) and treat the old `comment-server.ts` as legacy for `wd -c`. They can converge later.
- **Migrating existing `wd -c` reviews into the new dashboard.** Out of scope for V1. `wd -c` keeps working standalone.
- **Concurrent comment mutations from two browser tabs.** Server is the single source of truth, atomic writes, SSE notifies the other tab. Should be fine — `comment-store.ts` serializes via an in-memory mutex.
- **Many sessions in history.** If the user has 50 sessions, the sidebar needs virtualization. Note for V1.5 / V2.
- **PTY ownership when the same session is opened by `work dash` and `work web` simultaneously.** Two PTYs spawned, two views of Claude — each with its own conversation state. Not a bug, but worth telling the user about in docs.
- **Bundling React via Vite into a single static output that the Node server serves.** Need to wire tsup + Vite cleanly so `npm run build` produces both. Likely a tiny shell script or `npm-run-all`.
- **Adding xterm.js to package.json.** Bumps install size but only used in the SPA bundle, not the Node runtime. Fine.

## Notes for future phases (out of V1)

- V2: PRs/Jira/Tasks panes (read-only). Reuses `core/pr.ts`, `core/jira.ts`, `core/tasks.ts`. New SSE topics for refresh.
- V3: Worktree mutation (`work tree` / `work remove` / `work prune`) via web. Confirmation modals, error toasts.
- V4: PTY persistence across server restarts. Likely via `tmux`-style backed-up scrollback or a separate `work daemon` that owns long-running PTYs.

## Next steps

When implementation begins:
1. Land milestone 1 in a single PR (skeleton). Should be small and reviewable.
2. Each subsequent milestone its own PR.
3. Update this doc as decisions change. Mark sections **Done** as features ship.
