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
    // Half the cores: the git-heavy files saturate every core (git.exe
    // under AV scanning), and with one worker per core the main process got
    // starved enough to miss a worker RPC ("Timeout calling onTaskUpdate")
    // — an error that fails the run though every test passed. Wall time
    // is about the same either way; the run is just calmer.
    maxWorkers: '50%',
    // Tests run git against an empty config, never the developer's (commit
    // signing, hooks…), and under a throwaway HOME, never the developer's
    // ~/.work or ~/.claude — see tests/setup/.
    setupFiles: ['tests/setup/isolate-home.ts', 'tests/setup/isolate-git.ts'],
    // `npm run test:coverage` (CI keeps the lcov): what the tests run of src/,
    // reported, with no threshold yet — the number to watch, not to game.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
