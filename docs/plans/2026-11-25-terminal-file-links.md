# Plan: clickable file paths in the web terminal

Spec: `docs/specs/2026-11-25-terminal-file-links.md` · Branch: `feat/terminal-file-links` · One PR

## B1 — Find the paths (pure)

Files: `src/core/worktree/terminal-path-refs.ts`, `tests/core/worktree/terminal-path-refs.test.ts`

- `findPathRefs(text)`: `{ start, end, raw }[]` for `file://` addresses, absolute paths (`/`, `~/`, `C:\`), relative paths
  with a separator, bare names with an extension; `:line` / `:line:col` kept in `raw`; trailing punctuation dropped.
- `splitLine(raw)`: `{ path, line? }`; a `file://` address decoded to a path.
- `joinRows(rows, cols)`: the text of a row and the rows it continues onto (a row filled to `cols`; the next one's leading
  spaces dropped), with a map back to row/column so a link's range can span rows.
- No node imports: the browser imports it too.

Acceptance: every form in the spec, prose and version numbers (`v2.0.1`, `e.g.`) not matched.

## B2 — Resolve and open (core + server)

Files: `src/core/worktree/terminal-paths.ts`, `src/core/platform/launch.ts`, `src/core/api-types.ts`,
`src/server/routes/terminal-path-routes.ts`, `src/server/routes/worktree-routes.ts`, `src/server/web-server.ts`,
`src/server/demo/demo-server.ts`, and their tests.

- `resolveTerminalPath(session, raw, io)`: absolute → as is; relative → group folder, then each repo; bare name →
  `listRepoFiles` per repo, one match or `ambiguous`. `realpath` first, then kind and `opens` from the real path:
  viewer extension → `app`; other file → `editor`; folder → `reveal`.
- `openTerminalPath(session, raw, how)`: resolves again, then `openWithDefaultApp` (only when `opens === 'app'`),
  `startEditor`, or `revealInFileManager`. `how: 'default'` on anything else falls to the editor or reveal.
- `launch.ts`: `startEditor(folder, file)` is the spawn now inline in `open-editor` (moved, not changed);
  `openWithDefaultApp` (`open` / `explorer.exe` / `xdg-open`); `revealInFileManager` (`open -R` / `explorer.exe /select,` /
  `xdg-open <parent>`). Argument builders are pure and tested per platform.
- Routes with zod schemas and the limits in the spec; the demo: resolve says missing, open is `noLocalApps`.

Acceptance: the contracts and the Security section; `tests/server/routes/worktree-routes.test.ts` unchanged and green.

## B3 — Links in the terminal (browser)

Files: `src/web/src/api/panes.ts`, `src/web/src/state/terminal-links.ts`, `src/web/src/components/Terminal/PtyView.tsx`,
`tests/web/terminal-links.test.ts`

- `terminal-links.ts` (pure): candidates for a buffer row (joined first, then unjoined), a per-session cache with a short
  life, `pathMenuItems(result)`.
- `PtyView`: `term.registerLinkProvider`; the row's candidates resolved in one request; a link per existing one with its
  range; `activate` → open `default`; the hovered link remembered so the host's `contextmenu` opens `Menu` on it;
  `linkHandler.activate` sends a `file://` target the same way; failures in a toast.

Acceptance: spec Behaviour 3, 5 (except search), 6, 7, 8.

## B4 — Bare names to code search, docs

Files: `SessionDetail.tsx`, `CodeSearch.tsx`, `PtyView.tsx`, `.claude/references/work/pty-host.md`, `.claude/rules/security.md`

- `CodeSearch` takes `initialQuery`; `SessionDetail` opens it on a `work:code-search` event from the terminal.
- Docs: a "Paths in the terminal" paragraph and its § rule; security §1.5b.

Then: full `npm run typecheck && npm run lint && npm test && npm run build`, manual check (SC5), PR.
