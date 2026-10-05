import { defineConfig, devices } from '@playwright/test';

// End-to-end tests for `work web` + the PTY host. Each test builds its own
// isolated HOME (see e2e/fixtures.ts) and starts real `work` processes from
// dist/, so run `npm run build` first (`npm run test:e2e` does).
export default defineConfig({
  testDir: 'e2e',
  // Real processes, ports and ConPTYs per test — keep them from racing
  // each other (and antivirus) on a dev box.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
