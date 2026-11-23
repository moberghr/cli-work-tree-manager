# libghostty-vt 1.0.1 (WebAssembly)

The terminal emulator library of [Ghostty](https://ghostty.org), as its official prebuilt WebAssembly modules. work
uses it as an optional engine for the PTY host's copy of each terminal's screen (`src/core/pty/ghostty-mirror.ts`,
bound in `src/core/pty/ghostty/`), picked with config `terminalEngine: "ghostty"` or `WORK_TERMINAL_ENGINE=ghostty`
(`.claude/references/work/configuration.md`). The default engine is @xterm/headless; nothing here is read unless
ghostty is picked.

| File | What | SHA-256 |
|---|---|---|
| `ghostty-vt-1.0.1.wasm` | the fast build (ReleaseFast) — the one work loads | `2ee8434a58866aa3ce43cebbbf284d684f5f5b64c4f6040fa031cfe789e11646` |
| `ghostty-vt-1.0.1-small.wasm` | the small build (ReleaseSmall) — kept for size/speed comparisons, not loaded | `e226900d2126faab515668e5400b69fc78ba3d99aaf9525b325f79707b29bf01` |
| `LICENSE` | Ghostty's licence: MIT | |

Source: <https://release.files.ghostty.org/libghostty-vt/1.0.1/> (the release's `.wasm` assets; its C headers,
`include/ghostty/vt/*.h`, document the API the binding calls).

## How it ships

- **Dev** (`npm run dev`, tests): `src/core/pty/ghostty/wasm.ts` finds the module here, relative to its own
  `import.meta.url`.
- **Built CLI**: `tsup.config.ts` (`onSuccess`) copies `ghostty-vt-1.0.1.wasm` and the licence (as
  `ghostty-vt-1.0.1.LICENSE`) into `dist/`, next to the chunks; the loader looks there first. `dist` is in the npm
  package's `files`, so npm installs carry it.
- **Desktop app**: `desktop/scripts/stage-cli.mjs` copies the package's `files` (so `dist/`, wasm included); it needs
  no change of its own.

The module has no imports and is compiled once per process, the first time a ghostty screen is made; each terminal
gets its own instance of it.

## Updating

1. Download the new version's `.wasm` files and the licence from `https://release.files.ghostty.org/libghostty-vt/<version>/`.
2. Check them against the release's published checksums, and record the new SHA-256s in the table above
   (`shasum -a 256 *.wasm`).
3. Replace the files here (the names carry the version), and change the version in `src/core/pty/ghostty/wasm.ts`
   (`LIBRARY_VERSION`) and in `tsup.config.ts`.
4. The loader checks every export it uses (name and parameter count) and reads every struct offset from the module's
   own `ghostty_type_json()`; the option and data numbers in `src/core/pty/ghostty/terminal.ts` come from the headers —
   check them against the new ones. Then run `npx vitest run tests/core/pty/ghostty tests/core/pty/ghostty-mirror.test.ts`.
