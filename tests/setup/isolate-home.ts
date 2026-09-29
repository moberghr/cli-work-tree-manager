import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/**
 * Every test file gets its own throwaway HOME, so no test can touch the
 * developer's real ~/.work (state.db, debug.log, history) or ~/.claude —
 * even one that forgets to mock `os.homedir()`. Found by review: a test
 * reached the real state.db through the terminal WebSocket path, and six
 * files appended to the real debug.log on every run.
 *
 * Done through the environment, not a spy: `os.homedir()` reads USERPROFILE
 * on Windows and HOME elsewhere on every call, many tests end with
 * `vi.restoreAllMocks()` (which would drop a spy and fall back to the real
 * home), and child processes a test spawns inherit it. Tests that mock
 * `os.homedir()` to their own temp dir keep working as before.
 */
const real = os.homedir();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.WORK_TEST_REAL_HOME = real; // for the guard test only

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
