import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { closeLog, debug, getLogPath, setMaxLogSizeForTests } from '../../src/core/logger.js';

// HOME is a throwaway per test file (tests/setup/isolate-home.ts), so this
// writes to that ~/.work/debug.log, never the developer's.

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

afterEach(() => {
  closeLog();
  setMaxLogSizeForTests(5 * 1024 * 1024);
});

describe('debug log', () => {
  it('rotates to debug.log.1 while running, not only when a process starts', async () => {
    const file = getLogPath();
    expect(file.startsWith(os.homedir())).toBe(true);
    setMaxLogSizeForTests(2000);
    for (let i = 0; i < 40; i++) debug(`line ${i} ${'x'.repeat(80)}`);
    await until(() => fs.existsSync(file + '.1'));
    // 40 lines at a 2 KB cap rotate more than once: .1 holds the latest full file.
    const rotated = fs.readFileSync(file + '.1', 'utf-8');
    expect(rotated).toMatch(/line \d+ x/);
    expect(fs.statSync(file + '.1').size).toBeLessThan(2000 + 200);
    // Later lines go to a fresh debug.log, which stays under the cap.
    debug('after rotation');
    await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes('after rotation'));
    expect(fs.statSync(file).size).toBeLessThan(2000);
  });
});

describe('work hook (built binary)', () => {
  const BIN = path.resolve(__dirname, '../../dist/bin.js');
  it.skipIf(!fs.existsSync(BIN))('does not log a startup banner for every Claude hook', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-banner-'));
    try {
      const env = { ...process.env, HOME: home, USERPROFILE: home };
      spawnSync(process.execPath, [BIN, 'hook', 'checkpoint'], { env, input: '{}', timeout: 20_000 });
      spawnSync(process.execPath, [BIN, 'todo'], { env, timeout: 20_000 });
      const log = fs.readFileSync(path.join(home, '.work', 'debug.log'), 'utf-8');
      expect(log).not.toContain('work started hook');
      expect(log).toContain('--- work started todo ---');
    } finally {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
