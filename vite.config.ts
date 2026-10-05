import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workVersion } from './scripts/version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// The release tag is the version (scripts/version.mjs), as for the server bundle.
const version = workVersion(here);

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
    __WORK2_VERSION__: JSON.stringify(version),
  },
  plugins: [react()],
});
