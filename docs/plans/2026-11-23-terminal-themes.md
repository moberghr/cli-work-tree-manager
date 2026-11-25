# Terminal themes — plan

Spec: `docs/specs/2026-11-23-terminal-themes.md` (sidecar `.json`). Branch `feat/terminal-themes`, worktree `.claude/worktrees/terminal-themes`.

Rigor: HIGH (score 11 — 3 batches, 16 non-mechanical + 4 mechanical files, 1 external + 1 internal-tooling contract, security_impact=none). Phase 3: subagent per code batch; B3 (all mechanical) inline.

Plan-gap review (anti-anchored): 3 BLOCKING found and folded in — `tests/architecture/boundaries.test.ts` (`SPA_SHARED`), `tests/web/settings-page.test.ts` (section count and list), `tests/web/pty-view.test.ts` (fake Terminal has no `options`, PtyView would now fetch and open an EventSource). ADVISORY folded in: B1's verification widened; SC6 gets an automated restyle test; the store tolerates a failed fetch.

Wave schedule: W0: B1 · W1: B2 · W2: B3

## B1 — core (themes, schema, settings read)

Files: `src/core/settings/terminal-style.ts` (new), `src/core/settings/settings-schema.ts`, `src/core/settings/settings-admin.ts`, `src/core/api-types.ts`, `tests/core/settings/terminal-style.test.ts` (new), `tests/core/settings/settings.test.ts`, `tests/architecture/boundaries.test.ts` (`SPA_SHARED` += the module), `tests/web/settings-page.test.ts` (8 sections, `Terminal` after `Agents & terminals`).

- `terminal-style.ts`: `TerminalThemeId = 'default' | 'midnight' | 'dracula' | 'tokyo-night' | 'github-light'`; `TERMINAL_THEMES` (label + 21-colour palette each); `TERMINAL_COLOR_KEYS`; defaults (font stack = today's, 13, 1, `'default'`), ranges (size 8–32, line height 1–2), `TERMINAL_FONT_PATTERN` (refuses `;{}<>\`); `checkTerminalColors(raw: unknown): Record<string, string>`; `resolveTerminalStyle(values: Record<string, unknown>, colors?: Record<string, string>): TerminalStyle`.
- Schema: `'Terminal'` in `SettingSection` and `SETTING_SECTIONS` (after `'Agents & terminals'`); fields `terminal.theme` (choice, default `'default'`), `terminal.fontFamily` (text, default null, placeholder, pattern), `terminal.fontSize` (number 8–32, default 13), `terminal.lineHeight` (number 1–2, default 1). Help says what each does; the theme's says GitHub Light wants Claude's light theme. `SETTINGS_ELSEWHERE` adds the terminal's own colours (`terminal.colors`).
- `readSettings`: `terminalColors` from raw `terminal.colors` through `checkTerminalColors`, only when non-empty. `SettingsWire.terminalColors?: Record<string, string>`.

Acceptance: SC1–SC4. Verification: `npx vitest run tests/core tests/architecture tests/web/settings-page.test.ts && npm run typecheck && npm run lint`.
Boundary: core pure and print-free; the module imports nothing; only schema paths + checked colours on the wire.
Depends: none (first batch). Governing: §0.1, §2.1, §2.7, §2.8, §4.1, §4.2, §5.1.

## B2 — SPA (store, PtyView, stylesheets)

Files: `src/web/src/state/terminal-style.ts` (new), `src/web/src/components/Terminal/PtyView.tsx`, `src/web/src/styles/tokens.css`, `src/web/src/styles/global.css`, `src/web/src/styles/dashboard.css`, `src/web/src/styles/pages/accounts.css`, `tests/web/terminal-style.test.ts` (new), `tests/web/pty-view.test.ts` (the fake Terminal gets an `options` object; the store module mocked with a settable style; a test: a new style changes the same Terminal's options, opens no new socket, sends a resize when the grid changed).

- Store: current style (defaults until loaded), `loadTerminalStyle()` (one fetch in flight; a failed fetch keeps the current style), subscribers, `useTerminalStyle()` (subscribe + `useSse('/events', { events: { 'settings-changed': … } })`), sets `--term-bg` / `--term-fg` on `document.documentElement`.
- PtyView: `styleRef` read when the Terminal is built; `restyle` ref set by the connect effect (options + `onResize()`); an effect on the style calls it. The connect effect's deps unchanged.
- CSS: `--term-bg: #1e1e1e; --term-fg: #d4d4d4` in tokens.css `:root`; `.wd-pty-host`, `.wd-pty-host .xterm .xterm-viewport`, `.wd-pty-connecting` (text: `color-mix` of fg and bg), `.wd-assistant-body`, `.wd-term-slot`, `.wd-account-login-term` (+ `> p` colour) use them.

Acceptance: SC5, SC6 (test); no reconnect on restyle; unchanged look with nothing set; a failed settings fetch keeps the current style. Verification: `npx vitest run tests/web tests/architecture && npm run typecheck && npm run lint`.
Boundary: React in src/web only; connect effect independent of style; page stylesheets swap colours only, no shared ui class restyled.
Depends: B1 (imports the module and the wire type). Governing: §0.1, §0.3, §2.3, §4.1, §4.2.

## B3 — docs (inline, mechanical)

Files: `.claude/references/work/terminal-appearance.md` (new), `.claude/references/work/settings.md`, `.claude/references/work/configuration.md`, `CLAUDE.md` (Terminals and agents row).

Acceptance: describes what was built; the new file is listed. Verification: `npm run format:check`.
Depends: B2 (describes its behaviour).

## After the batches

`npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`; SC6 in the running app (`npm run dev -- web` from the worktree), screenshots of each theme for the PR; spec-drift check; review (compliance, then test-reviewer + context-miner); cleanup; PR with screenshots, assigned to the user (asked before pushing per the global rules — the user asked for the PR).

## Part 2 — the app's theme (same PR)

Spec: "Part 2" in `docs/specs/2026-11-23-terminal-themes.md` (SC8–SC14). The Part 1 names above are as they were built then: `state/terminal-style.ts` became `state/appearance.ts` (`loadAppearance`, `useAppearanceUpdates`), its test `tests/web/appearance.test.ts`, and `terminal-appearance.md` became `appearance.md`.

- **B4 — core**: `core/settings/app-theme.ts` (new: `APP_THEMES`, `resolveAppTheme`), `resolveTerminalStyle(values, colors, follow)`, the schema's Theme section (`theme`, `terminal.theme` gains `app`), `loadConfig` keeps `theme`. SC8–SC10.
- **B5 — SPA**: the appearance store (app theme + terminal style, stamps on `<html>`, cache mirrors config), `ThemeProvider` an adapter over it, the boot script paints named themes. SC11, SC13. Depends on B4.
- **B6 — CSS + docs**: named-theme blocks and per-base `--term-*` in `tokens.css`, three `diff.css` surfaces as tokens, `appearance.md` and its pointers. SC12. Depends on B4.

After: the same commands as above; SC14 in `work web --demo` (each app theme, the terminal following, Settings → Theme), screenshots added to `pr-assets/terminal-themes`.
