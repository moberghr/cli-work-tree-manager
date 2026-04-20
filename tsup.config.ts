import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  sourcemap: true,
  splitting: false,
  define: {
    __WORK2_VERSION__: JSON.stringify(pkg.version),
  },
  external: [
    'chalk',
    'cross-spawn',
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
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
