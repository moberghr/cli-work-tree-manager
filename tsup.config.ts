import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/bin.ts', 'src/wd-bin.ts'],
  // Vite owns dist/web/ and it must survive a server-only build. tsup's
  // clean ALWAYS deletes `**/*` in outDir and appends these as extra glob
  // patterns — so they must be negations. (The old list of file names was
  // read as "delete these too", which wiped the SPA on `npm run build:server`.)
  clean: ['!web/**'],
  format: ['esm'],
  target: 'node22',
  sourcemap: true,
  splitting: false,
  define: {
    __WORK2_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    'chalk',
    'cross-spawn',
    'chokidar',
    'diff',
    'glob',
    'inquirer',
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
