# HTML and artifacts beside the terminal — spec (2026-11-26)

## Goal

Look at what an agent produces — HTML (Claude's artifacts first of all), Markdown, images — in the pane beside its
terminal (`ShownFilePane`, `work show`), without leaving the session. Builds on the shown-file pane and on clickable
terminal paths (#94).

## Behaviour

1. **HTML is rendered.** A shown `.html` / `.htm` file is drawn in a sandboxed frame, its scripts on (artifacts are often
   interactive and load libraries from a CDN). It reloads when the file changes (the pane already re-reads every 3 s;
   the frame reloads only when the content changed, so an interactive page isn't reset for nothing).
2. **The agent's own temp folder counts.** Besides a file the Code tab lists, a session may show a file in its agent's
   own temp folder — Claude's `<tmp>/claude-<uid>/<encoded folder>/…` (macOS/Linux `/tmp/claude-<uid>`, Windows
   `%TEMP%\claude`), where Claude writes an artifact's HTML before it publishes it. Only the folders of THIS session's
   own folders (its root and each repo, encoded as Claude's projects folders are), judged on the real path with links
   followed; a regular file; nothing else on the disk. `work show <file>` and a terminal click both take it.
3. **A click in the terminal on an HTML, Markdown or image path shows it beside the terminal** (when the session can
   show it); anything else, or a file it can't show, opens as today (#94: the system's app for viewer types, the
   editor otherwise). The right-click menu gets **Show beside the terminal** for those kinds.
4. **The pane's buttons**: **Open in app** (the system's default app for viewer types, the editor for the rest — #94's
   open route, `how: default`), **Show in Finder** (Explorer / file manager; `how: reveal`), alongside Code tab (only
   for a listed file) and ×.
5. Claude.ai artifact links (published artifacts) stay web links: claude.ai can't be framed and needs your login.
6. `work show` and the work-sessions skill say an artifact's local HTML can be shown.

## Security

- The HTML is served by `GET /api/sessions/:id/show/page` — only the file the session shows now (the browser names no
  path), with `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms` (no `allow-same-origin`: an
  opaque origin), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and the
  frame carries the same `sandbox` attribute. From its opaque origin the page can never read work web's answers: no
  route sends CORS headers (a test keeps it so). `refuseReason` (§1.5) refuses its requests besides (cross-site, and
  `Origin: null` on every method); it can't reach the dashboard's DOM, cookies, storage or terminals
  (the PTY host takes only tickets, §1.5a). It can reach the internet, as the same file opened in a browser does today
  (§1.5b accepted that). No top navigation.
- In the desktop app the page can't ask the app anything (restart, update, badge): asks carry a per-launch secret only
  the window's top page gets. Accepted: it can navigate its own frame to a web page, which the app opens in the browser.
- The temp-folder rule is checked on the server on the real path, for showing and again for every read; a path the
  browser or the agent gives is never trusted. `/tmp` is shared, so the root is trusted only as a real folder of the
  user's that nobody else can write or read (owner and mode checked), and neither it nor the session's folder may be a
  link. Reads don't follow a link swapped in after the check (`O_NOFOLLOW`) and stop at the size limit. Size limits: text 2 MB (the Code tab's), HTML 5 MB, images as today.
- Another machine's path is refused (`refusedPath`), as for terminal paths.
- The demo shows nothing (as today).

## Success criteria

- SC1 `shownKind` gives `html` for `.html`/`.htm`; the pane draws it in a sandboxed frame from the page route; the
  route's headers as above; it serves only the shown file; 404 when none or gone; too large refused.
- SC2 Temp-folder files: accepted inside the session's own agent temp folders (real path), refused outside them, for a
  link pointing out, for another session's folder, for a folder; shown by absolute path; read for text/markdown and
  images through the same rule.
- SC3 A terminal click on an html/md/image path that the session can show shows it beside the terminal; one it can't
  opens as before; the menu item is there for those kinds.
- SC4 The pane's Open in app / Show in Finder call #94's open route with the shown file's absolute path.
- SC5 Docs (session-navigation.md, security.md §1.5c), the skill, CHANGELOG.

## Out of scope

Framing claude.ai artifacts; an artifact's relative files; several files at once; showing files elsewhere on the disk.
