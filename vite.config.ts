import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  fs.readFileSync(path.resolve(here, 'package.json'), 'utf-8'),
);

export default defineConfig({
  root: path.resolve(here, 'src/web'),
  base: '/',
  build: {
    outDir: path.resolve(here, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  // Same build-time version constant the server bundle uses (tsup defines it
  // too) so the SPA can show the shipped version without an API round-trip.
  define: {
    __WORK2_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [react()],
});
