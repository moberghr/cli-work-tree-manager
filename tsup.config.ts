import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  // install-skills-bin: npm's postinstall runs only that (scripts/postinstall.mjs), never the whole CLI.
  entry: ['src/bin.ts', 'src/wd-bin.ts', 'src/install-skills-bin.ts'],
  // Vite owns dist/web/ and it must survive a server-only build. tsup's
  // clean ALWAYS deletes `**/*` in outDir and appends these as extra glob
  // patterns — so they must be negations. (The old list of file names was
  // read as "delete these too", which wiped the SPA on `npm run build:server`.)
  clean: ['!web/**'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  // Split into chunks so bin.ts's dynamic imports stay lazy: `work hook`
  // (run several times per Claude turn) loads only the hook's code, not
  // every command and its native modules.
  splitting: true,
  define: {
    __WORK2_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    'chalk',
    'cross-spawn',
    'chokidar',
    'glob',
    '@inquirer/prompts',
    'yargs',
    'yargs/helpers',
    'node-pty',
    'better-sqlite3',
    '@xterm/headless',
    '@xterm/addon-serialize',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
