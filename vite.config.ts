import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(here, 'src/web'),
  base: '/',
  build: {
    outDir: path.resolve(here, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  plugins: [react()],
});
