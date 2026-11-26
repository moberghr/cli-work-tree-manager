# HTML and artifacts beside the terminal — plan (2026-11-26)

Spec: `docs/specs/2026-11-26-html-artifact-preview.md`. Rigor HIGH (serves HTML with scripts; widens what a session may
show), so: read the area files first (`session-navigation.md`, `security.md` §1.5/§1.5b), tests with every batch, a
security review of the whole change before it is called done.

## Batch 1 — core: kinds and where a file may be (SC1, SC2)
- `core/sessions/shown-file.ts`: `ShownKind` adds `html`; a shown file is either a listed one (`{repo, path}`) or one in
  the agent's temp folder (`{temp: absolute real path}`); `locateShown(session, file)` tries the session's folders,
  then the agent's temp roots.
- Agent interface: optional `tempRoots(session): string[]` (agents/types.ts); Claude's in `agents/claude/` —
  `<root>/<encodeProjectDir(folder)>` per run folder (`sessionRunFolders`), root `/tmp/claude-<uid>` (POSIX, real path),
  `%TEMP%\claude` (Windows). `insideTempRoots(real, roots)` pure.
- Tests: kinds; temp roots per platform; inside / outside / link out / other session / folder.

## Batch 2 — routes (SC1, SC2, SC4)
- `session-show-routes.ts`: POST accepts a temp-folder file; `GET …/show/page` (HTML, headers above, size cap);
  `GET …/show/text` for a temp file's text (a listed one keeps the Code tab's read); the image route reads a temp file
  too; every read re-checks the rule. Wire: `SessionShownWire.shown` gains `temp?: true` and `abs` (the absolute path,
  for the pane's buttons). Demo unchanged (shows nothing) — its routes still answer the same.
- Tests: route headers, only-the-shown-file, refusals, temp reads; `refuseReason` refuses a request from the sandboxed
  page (`Origin: null`, cross-site).

## Batch 3 — pane and terminal (SC1, SC3, SC4)
- `ShownFilePane`: `html` in an `<iframe sandbox="allow-scripts allow-popups allow-forms">` from the page route,
  reloaded when the text changed; buttons Open in app / Show in Finder (`openTerminalPath(id, abs, 'default'|'reveal')`);
  Code tab only for a listed file.
- `PtyView` / `state/terminal-links.ts`: a plain click on an html/htm/md/markdown/image path → `showSessionFile(id,
  {file})`; refused → today's open; the menu's **Show beside the terminal** for those kinds.
- Tests: pane draws the frame with the sandbox and the buttons call the open route; click routing and the menu item.

## Batch 4 — docs, skill, changelog (SC5)
- `.claude/references/work/session-navigation.md` (the pane), `.claude/rules/security.md` §1.5c (the page route and the
  temp-folder rule), `plugins/work-tree/skills/work-sessions/SKILL.md` (show an artifact's HTML), `commands/show.ts`
  help, CHANGELOG Unreleased.

## Gate sequence
Per batch: typecheck + its tests + lint. After: full suite, format, build, an independent security review of the diff
(sandbox, routes, path rule), then fixes.
