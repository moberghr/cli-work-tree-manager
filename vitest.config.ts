import { defineConfig } from 'vitest/config';

// The repo-level Vite config (vite.config.ts) is scoped to src/web for the
// SPA build. We don't want vitest using its `root` — tests live under
// /tests/, so give vitest its own minimal config that walks the whole repo.
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts'],
  },
});
