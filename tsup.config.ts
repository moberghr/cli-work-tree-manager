import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  sourcemap: true,
  splitting: false,
  external: [
    'chalk',
    'cross-spawn',
    'glob',
    'inquirer',
    '@inquirer/prompts',
    'yargs',
    'yargs/helpers',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
