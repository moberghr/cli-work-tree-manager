# Terminal themes — spec

- Date: 2026-11-23 · Branch: `feat/terminal-themes` (worktree `.claude/worktrees/terminal-themes`)
- Scope: `new-feature` · Spec mode: standard · `security_impact`: none
- Ambiguity gate: ran before drafting. The user chose config.json over per-browser storage, the 5 built-in themes plus `terminal.colors` overrides by hand in config.json (no colour editor), and the theme set Default dark / Midnight / Dracula / Tokyo Night / GitHub Light.

## Summary

Every terminal in work web (a session's, the Ctrl+K assistant's, an account sign-in's) is one `PtyView` whose look is hard-coded: 13 px, the Cascadia/SF Mono stack, `#1e1e1e` on `#d4d4d4`, xterm's default ANSI colours (`src/web/src/components/Terminal/PtyView.tsx:114-117`), and the same `#1e1e1e` repeated in five stylesheet rules. This adds a **Terminal** section to the Settings page — theme (5 built-ins), font family, font size, line height — kept in `~/.work/config.json` under `terminal.*`, plus `terminal.colors` written by hand to override any colour of the chosen theme. Open terminals restyle as soon as a setting is saved, without reconnecting.

## Success criteria

| Id | Criterion | Verification | Channel | Observable |
|---|---|---|---|---|
| SC1 | Each of the 5 themes defines all 21 colours (background, foreground, cursor, cursorAccent, selectionBackground, 16 ANSI) as hex; Default dark is today's look exactly (`#1e1e1e` / `#d4d4d4`, xterm's own Tango ANSI, cursor `#ffffff`, accent `#000000`, selection `#ffffff4d`). | `tests/core/settings/terminal-style.test.ts` | test-run | the theme tests pass |
| SC2 | The schema has a `Terminal` section with `terminal.theme` (choice), `terminal.fontFamily` (text), `terminal.fontSize` (8–32), `terminal.lineHeight` (1–2); its choice options equal the theme module's ids and labels, its defaults equal the module's defaults; a value out of range or a font name with `;{}<>\` is refused. | `tests/core/settings/settings.test.ts` | test-run | the schema tests pass |
| SC3 | `resolveTerminalStyle(values, colors)`: nothing set → today's options; each hand-written value that doesn't fit falls back to its own default (the others kept); a font name set is followed by the default stack; overrides apply only for known colour keys with a hex value. | `tests/core/settings/terminal-style.test.ts` | test-run | the resolve tests pass |
| SC4 | `GET /api/settings` (`readSettings`) carries `terminalColors`: the valid entries of config.json's `terminal.colors`, nothing else; absent when there are none. | `tests/core/settings/settings.test.ts` | test-run | the settings-over-config tests pass |
| SC5 | The SPA's terminal style store loads the settings once for every terminal, loads again on `settings-changed`, tells its subscribers, and sets `--term-bg` / `--term-fg` on `<html>`. | `tests/web/terminal-style.test.ts` | test-run | the store tests pass |
| SC6 | An open terminal takes a changed theme, font, size or line height without reconnecting: xterm's options change, the grid is refitted and the PTY resized when its columns or rows changed; a terminal hidden in the deck refits when shown. | `tests/web/pty-view.test.ts` (same Terminal, same socket, options changed, a resize sent when the grid changed); then `work web` from this worktree: change the theme and the font size on Settings, look at an open session's terminal | test-run + browser | the restyle test passes, and the open terminal changes colours and size with no "Connecting…" |
| SC7 | Type check, lint, format check, the whole test suite and the build pass. | `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` | build-output | every command exits 0 |

## Architecture and design

**One pure module, `src/core/settings/terminal-style.ts`** (import-free like `settings-schema.ts`, so the SPA and the server both import it): `TERMINAL_THEMES` (id → label + palette), `TERMINAL_COLOR_KEYS`, `DEFAULT_TERMINAL_FONT_FAMILY` (today's stack), `DEFAULT_TERMINAL_FONT_SIZE` 13, `DEFAULT_TERMINAL_LINE_HEIGHT` 1, `DEFAULT_TERMINAL_THEME` `'default'`, the ranges, `checkTerminalColors(raw)` (keeps known keys with `#rgb`/`#rrggbb`/`#rrggbbaa`), `resolveTerminalStyle(values, colors)` → `{ themeId, theme, fontFamily, fontSize, lineHeight }`. Field-by-field fallback: a hand edit that doesn't fit never breaks the terminal.

Themes (palettes all MIT-licensed upstream; Midnight is work's own):
- **Default dark** — today's look, xterm's defaults spelled out.
- **Midnight** — near-black `#0d0d10`, crisp `#e4e4e7` text, a clean bright ANSI set (Warp-like feel, not Warp's).
- **Dracula** — the official Dracula ANSI spec.
- **Tokyo Night** — the "night" variant of the terminal ports.
- **GitHub Light** — GitHub Light Default's terminal colours; its help says to switch Claude Code to its light theme (`/theme`).

**Schema** (`settings-schema.ts`): a new `SettingSection` `'Terminal'` (after `'Agents & terminals'`), four fields. The schema stays import-free: its choice options and defaults are written there and a test ties them to the module. `SETTINGS_ELSEWHERE` mentions the terminal's own colours.

**Server**: `readSettings` adds `terminalColors` (from raw config.json `terminal.colors`, through `checkTerminalColors`) to `SettingsWire` (optional field, `api-types.ts`). Writing is unchanged (the four fields go through the schema like every other; `terminal.colors` is only hand-written). The demo source is unchanged (no colours there: the field is optional).

**SPA**: `src/web/src/state/terminal-style.ts` — a store shared by every `PtyView`: one `fetchSettings()` in flight at a time, the resolved style, subscribers, `useTerminalStyle()` (subscribes; re-loads on `settings-changed` through `useSse('/events', …)`, which shares one EventSource per URL). On every new style it sets `--term-bg` / `--term-fg` on `document.documentElement`. Until the first load: the defaults (today's look), so nothing flashes for anyone who never set anything.

**PtyView**: the `Terminal` is built from the current style (ref, read inside the connect effect, so a change never reconnects); a second effect on the style applies it to a live terminal through a `restyle` ref the connect effect sets: `term.options.theme/fontFamily/fontSize/lineHeight`, then the existing `onResize()` (fits only when active; a hidden one refits when shown — `shown.current`).

**CSS**: `tokens.css` defines `--term-bg: #1e1e1e; --term-fg: #d4d4d4` in `:root`; the six hard-coded terminal colours become `var(--term-bg)` / `var(--term-fg)` (`.wd-pty-host`, its `.xterm-viewport`, `.wd-pty-connecting`, `.wd-assistant-body`, `.wd-term-slot`, `.wd-account-login-term` and its `> p`); the connecting text's `#9da5b4` becomes a mix of the two so it reads on a light theme too.

### Rejected alternatives
- trap: per-browser localStorage (like light/dark) — the user chose config.json: one look in the browser and the desktop app, and it survives work web changing port.
- trap: a separate `GET /api/terminal-style` route — it would need a route, a `SettingsSource` method and the demo's copy; the settings read already carries the four values, one optional field carries the colours.
- trap: importing the palettes into `settings-schema.ts` — the schema is import-free by design; a test ties the option list and defaults to the module instead.
- trap: bundling a font (JetBrains Mono, Hack) — weight in every install for a choice the user makes once; any installed font works by name.

## Security and compliance impact

`none`. No auth, secrets, PII or IAM path. The font name is the user's own text from their own config.json, checked by a pattern that refuses `;{}<>\` and passed to xterm as an option (canvas font), never into HTML. Colours are hex only. `readSettings` still returns only schema paths plus the checked colours — nothing else of config.json leaves it.

## Change manifest

| Path | Action | Purpose |
|---|---|---|
| `src/core/settings/terminal-style.ts` | create | themes, defaults, colour check, resolve (pure) |
| `src/core/settings/settings-schema.ts` | modify | Terminal section, four fields, SETTINGS_ELSEWHERE |
| `src/core/settings/settings-admin.ts` | modify | `readSettings` carries `terminalColors` |
| `src/core/api-types.ts` | modify | `SettingsWire.terminalColors?` |
| `tests/core/settings/terminal-style.test.ts` | create | SC1, SC3 |
| `tests/core/settings/settings.test.ts` | modify | SC2, SC4 |
| `tests/architecture/boundaries.test.ts` | modify | the SPA may import the new pure module (`SPA_SHARED`) |
| `tests/web/settings-page.test.ts` | modify | the page now has 8 sections, Terminal among them |
| `src/web/src/state/terminal-style.ts` | create | the SPA store + hook + CSS variables |
| `src/web/src/components/Terminal/PtyView.tsx` | modify | built from the style, restyled live |
| `src/web/src/styles/tokens.css` | modify | `--term-bg` / `--term-fg` defaults |
| `src/web/src/styles/global.css` | modify | host, viewport, connecting overlay use the variables |
| `src/web/src/styles/dashboard.css` | modify | assistant body, terminal slot use the variable |
| `src/web/src/styles/pages/accounts.css` | modify | sign-in terminal box uses the variables |
| `tests/web/terminal-style.test.ts` | create | SC5 |
| `tests/web/pty-view.test.ts` | modify | the fake Terminal gets `options`; the store mocked; SC6 restyle test |
| `.claude/references/work/terminal-appearance.md` | create (mechanical) | the area's reference |
| `.claude/references/work/settings.md` | modify (mechanical) | the Terminal section |
| `.claude/references/work/configuration.md` | modify (mechanical) | `terminal.*` keys |
| `CLAUDE.md` | modify (mechanical) | list the new reference file |

## Test manifest

- `tests/core/settings/terminal-style.test.ts` — SC1, SC3
- `tests/core/settings/settings.test.ts` — SC2, SC4
- `tests/web/terminal-style.test.ts` — SC5
- `tests/web/pty-view.test.ts` — SC6 (restyle without reconnect); the colours themselves by looking at the running app (xterm's canvas/WebGL doesn't render under jsdom)
- `tests/architecture/boundaries.test.ts`, `tests/web/settings-page.test.ts` — kept true to the new module and section
- SC7 by the commands.

## Implementation batches

- **B1 — core** (`terminal-style.ts`, `settings-schema.ts`, `settings-admin.ts`, `api-types.ts` + `tests/core/settings/*`, `tests/architecture/boundaries.test.ts`, `tests/web/settings-page.test.ts`): SC1–SC4.
- **B2 — SPA** (store, `PtyView.tsx`, the four stylesheets + `tests/web/terminal-style.test.ts`, `tests/web/pty-view.test.ts`): SC5, SC6. Depends on B1. The store tolerates a failed settings fetch (keeps the style it has), so a page or test without the route still draws today's terminal.
- **B3 — docs** (three reference files + `CLAUDE.md`), mechanical, inline. Depends on B2.

## Risks and assumptions

- [VERIFIED:node_modules/@xterm/xterm/lib/xterm.mjs] xterm's defaults are the Tango ANSI set, cursor `#ffffff`, accent `#000000`, selection `rgba(255,255,255,0.3)`.
- [VERIFIED:node_modules/@xterm/xterm/typings/xterm.d.ts] `terminal.options` is settable at runtime (theme, fontFamily, fontSize, lineHeight).
- [VERIFIED:src/web/src/api/events.ts] `useSse` shares one EventSource per URL (`acquireEventSource`), so each PtyView subscribing costs no connection.
- [VERIFIED:src/web/src/state/settings-view.ts] the Settings page lists sections from `SETTING_SECTIONS`: a new section shows with no page change.
- [VERIFIED:src/server/demo/demo-settings.ts] the demo checks settings through the same `checkSetting`: the new fields work there unchanged.
- [VERIFIED:src/web/src/components/Terminal/PtyView.tsx] `onResize` fits only while active and `shown.current` refits when shown: a hidden terminal picks up a font change when shown.
- A font name that isn't installed falls back to the default stack (it follows the user's). A web font is out of scope.
- On GitHub Light, Claude Code in its dark theme draws some text light-on-light: the theme's help says to switch Claude's theme.
- A font size change resizes the PTY: Claude redraws its screen, as on any window resize.
- dirty-worktree: none (the worktree was clean at start; the main checkout's own changes are not in it).

## Open questions

None.

## Prior Work Check

`grep -rniE "terminal-?theme|termTheme|--term-bg|terminalStyle" src tests` → no matches. No existing terminal styling to reuse; the light/dark `ThemeProvider` is the app's, not the terminal's. Verdict: CLEAR.
