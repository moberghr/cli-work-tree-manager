import { defineConfig } from 'vitest/config';

// The repo-level Vite config (vite.config.ts) is scoped to src/web for the
// SPA build. We don't want vitest using its `root` — tests live under
// /tests/, so give vitest its own minimal config that walks the whole repo.
export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts'],
    // Many tests spawn real git subprocesses (worktree create/remove,
    // merge-detection, prune, sync, snapshot). On Windows with AV
    // scanning each git.exe invocation, the cumulative latency can
    // push past the 5 s default when the suite runs in parallel.
    // Raise the floor to 20 s so flaky timeouts don't mask real bugs.
    testTimeout: 20_000,
  },
});
