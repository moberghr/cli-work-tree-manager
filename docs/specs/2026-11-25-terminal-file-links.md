# Clickable file paths in the web terminal

Date: 2026-11-25 · Scope: new feature · Branch: `feat/terminal-file-links`

## Problem

The web terminal (`src/web/src/components/Terminal/PtyView.tsx`) opens only `http(s)` links (`openLink`). A file path or a
`file://` address an agent prints does nothing on a click, and there is no menu for it. The existing
`POST /api/sessions/:id/open-editor` takes only a file the Code tab lists, so it cannot open a file outside the worktree
(a scratchpad mockup in `/private/tmp`, for instance).

## Behaviour

1. **What is a path.** In the terminal's text: a `file://` address; an absolute path (`/…`, `~/…`, `C:\…`); a relative path
   with a `/` or `\` in it; a bare file name with an extension (`SessionRail.tsx`). Each with an optional `:line` or
   `:line:col`. Trailing punctuation (`.`, `,`, `)`, `]`, `"`, `'`, `:`) is not part of it.
2. **Wrapped paths.** A path that runs to the terminal's last column continues on the next row (xterm's own soft wrap, and
   the rows Claude Code breaks itself, whose continuation is indented). The joined text is tried first and kept only when
   it exists on disk; otherwise the unjoined piece is tried.
3. **Only real paths are links.** The browser asks the server which candidates exist; only those underline on hover.
   Answers are cached per session for a few seconds.
4. **Resolving.** Absolute paths as they are (`~` is the home folder). A relative path is tried against the session's
   folders: a group's folder, then each repo's worktree. A bare file name is looked up in the session's listed files
   (what the Code tab lists): exactly one match is that file; several is "ambiguous".
5. **Plain click opens**, by the kind of file, decided on the server:
   - a viewer type (`html`, `htm`, `pdf`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`) with the system's default app;
   - any other file in the configured editor (config `editor`, `code` by default) at its line;
   - a folder is revealed in the file manager, never opened (a `.app` is a folder that runs);
   - an ambiguous bare name opens the Ctrl+T code search with the name typed in.
6. **Right-click on a path** shows a menu: Open, Open in editor, Reveal in Finder (Explorer / file manager on other
   systems), Copy path. The full resolved path is the menu's footer. Right-click elsewhere in the terminal is the
   browser's own menu, as today.
7. **Terminal hyperlinks (OSC 8)** with a `file://` target go the same way. Web links are unchanged.
8. A failure (file gone, editor missing) shows in a toast.

## Security

Terminal text is not trusted: an agent prints what it read. The rules:

- The server never starts a file. The default app is used only for the viewer types above (an allowlist by extension,
  checked on the real path after links are followed); everything else is handed to the editor as a file to show, or
  revealed.
- The open route resolves the path again itself; it takes nothing the browser claims about it (kind, existence).
- Both routes are `POST`, so `refuseReason` refuses them from any other site, another localhost port included (§1.5). A
  cross-site page therefore cannot ask which files exist.
- Processes start with an argv array through `cross-spawn` (§1.1), `windowsHide: true`, detached as `detachHere()` says.
- Limits: 50 paths per resolve, 4096 characters per path, line ≤ 10 000 000.
- The demo opens nothing (`noLocalApps`) and says no path exists.

## Public contracts (internal tooling)

- `POST /api/sessions/:id/terminal-paths/resolve` `{ paths: string[] }` → `TerminalPathsWire`:
  `{ results: Array<{ raw, path: string | null, kind: 'file' | 'dir' | 'ambiguous' | 'missing', opens: 'app' | 'editor' | 'reveal' | 'search' | null, line?: number }> }`
- `POST /api/sessions/:id/terminal-paths/open` `{ path: string, how: 'default' | 'editor' | 'reveal' }` →
  `{ ok: true, opened: string }`, 404 when it no longer exists, 500 when the program could not start.

## Change manifest

| File | Action | Purpose |
|---|---|---|
| `src/core/worktree/terminal-path-refs.ts` | create | Pure: find path candidates in a row of text, split `:line`, join wrapped rows |
| `src/core/worktree/terminal-paths.ts` | create | Resolve a candidate against a session's folders and files; decide how it opens; open it |
| `src/core/platform/launch.ts` | modify | `startEditor` (moved out of the route), `openWithDefaultApp`, `revealInFileManager` |
| `src/core/api-types.ts` | modify | `TerminalPathsWire` and its row |
| `src/server/routes/terminal-path-routes.ts` | create | The two routes |
| `src/server/routes/worktree-routes.ts` | modify | `open-editor` uses `startEditor` |
| `src/server/web-server.ts` | modify | Mount the routes |
| `src/server/demo/demo-server.ts` | modify | Demo answers |
| `src/web/src/api/panes.ts` | modify | `resolveTerminalPaths`, `openTerminalPath` |
| `src/web/src/state/terminal-links.ts` | create | Pure: candidates for a buffer row, the cache, the menu's items |
| `src/web/src/components/Terminal/PtyView.tsx` | modify | Link provider, click, right-click menu, `file://` hyperlinks, toast |
| `src/web/src/components/Dashboard/SessionDetail.tsx` | modify | Open the code search with a query from the terminal |
| `src/web/src/components/Code/CodeSearch.tsx` | modify | Take an initial query |
| `.claude/references/work/pty-host.md` | modify | The feature and its § rule |
| `.claude/rules/security.md` | modify | §1.5b: a path from the terminal |

## Test manifest

| File | Covers |
|---|---|
| `tests/core/worktree/terminal-path-refs.test.ts` | Each path form, `:line`, trailing punctuation, soft and hard wraps, what is not a path |
| `tests/core/worktree/terminal-paths.test.ts` | Resolving (absolute, `~`, relative, group, bare name unique / ambiguous / none), how each kind opens, links followed before the type is judged |
| `tests/core/platform/launch.test.ts` | Arguments of the default-app and reveal commands per platform |
| `tests/server/routes/terminal-path-routes.test.ts` | Validation, limits, unknown session, the open route re-resolving, a runnable file never started |
| `tests/web/terminal-links.test.ts` | Candidates per row with joins, cache expiry, menu items per kind |

## Success criteria

- SC1: every path form in Behaviour 1 is found, with its line, and nothing in ordinary prose is (tests).
- SC2: a path wrapped over two or more rows resolves as one path (tests).
- SC3: a path that does not exist is never a link (tests).
- SC4: `how: 'default'` on a `.sh`, `.command`, `.exe` or an `.app` folder starts no default-app process: the editor or reveal is used (tests assert the spawned command).
- SC5: a click on a listed `html` file opens it; a click on a `.ts:202` opens the editor at line 202 (manual, in the running app).
- SC6: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass.

## Out of scope

- Paths inside the Diff, Code or Review tabs, and in the real terminal (`work attach`).
- Opening a file in work's own Code tab from the terminal.
- A setting for the modifier key or the viewer types.

## Assumptions

- [ASSUMED] Claude Code's own line breaks leave a path's first row filled to the last column; a row that is not full is never joined.
- xterm 6's `registerLinkProvider` gives an async callback per row, so a server answer can be awaited there.

## Risks

- A wrong join could link text that is not a path: limited by keeping a join only when the result exists.
- Many candidates on a busy screen: one batched request per row scan, cached.
- The existing `open-editor` route changes shape (its spawn moves to core); its tests must still pass unchanged.
