import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { getConfigDir } from '../../src/core/config.js';
import { dbPath } from '../../src/core/db.js';

/** Guards the guard (tests/setup/isolate-home.ts): nothing a test does can
 *  reach the developer's real ~/.work or ~/.claude. */
describe('tests run under a throwaway HOME', () => {
  it('os.homedir(), ~/.work and state.db all point into a temp dir, not the real home', () => {
    const real = process.env.WORK_TEST_REAL_HOME!;
    expect(real).toBeTruthy();
    expect(path.resolve(os.homedir())).not.toBe(path.resolve(real));
    expect(path.resolve(os.homedir()).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    expect(getConfigDir().startsWith(os.homedir())).toBe(true);
    expect(dbPath().startsWith(os.homedir())).toBe(true);
  });
});
