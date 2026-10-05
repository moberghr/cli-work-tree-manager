# 0006. The desktop app ships through Velopack with the CLI inside

- Status: Accepted
- Date: 2026-09 (recorded 2026-10-03)

## Context

A desktop window over `work web` (Tauri, `desktop/src-tauri`) needs the CLI
it shows: a separately installed `work` can drift from the app, or be
missing. Updating must not kill the PTY host and every running agent.

## Decision

- The app bundles the CLI (`cli/`: the npm package's files, its production
  `node_modules` built for that OS, and the Node that built them), staged by
  `desktop/scripts/stage-cli.mjs`. One update moves both.
- It runs from a copy, `~/.work/runtime/<version>/`, never the install folder,
  which Velopack replaces (and on Windows, stops whatever runs from it).
- `work` / `wd` launchers in `~/.work/bin` are appended to PATH, so an
  npm-installed `work` stays first.
- It ships on the same GitHub Release as npm (`vX.Y.Z`), for Windows,
  macOS arm64 and Linux; updates come from GitHub Releases.
- The pack id `WorkDesktop` and bundle id `hr.moberg.work-desktop` are
  permanent.

## Consequences

- No version skew between the app and its CLI.
- Old runtime copies are cleaned once nothing runs from them (the newest two
  kept).
- Changing either id would orphan every installed copy.
