import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/bin.ts', 'src/wd-bin.ts'],
  // Only clean tsup's own outputs — Vite owns dist/web/ and shouldn't be wiped.
  clean: ['bin.js', 'bin.js.map', 'wd-bin.js', 'wd-bin.js.map'],
  format: ['esm'],
  target: 'node18',
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
    '@xterm/headless',
    'ink',
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
