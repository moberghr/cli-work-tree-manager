import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'best-effort-'));
vi.mock('../../../src/core/platform/config.js', () => ({ getConfigDir: () => dir }));

import { bestEffort, bestEffortAsync, swallow } from '../../../src/core/platform/best-effort.js';

/** The log stream writes asynchronously: poll until `expected` lands (a
 *  fixed sleep was flaky under full-suite load). */
const log = async (expected: string) => {
  const file = path.join(dir, 'debug.log');
  const deadline = Date.now() + 5000;
  let text = '';
  while (Date.now() < deadline) {
    text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (text.includes(expected)) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return text;
};

describe('best-effort helpers swallow AND record', () => {
  it('returns the value, or the fallback on throw — and logs the label and error', async () => {
    expect(bestEffort('ok path', () => 7)).toBe(7);
    expect(bestEffort('restore session s1', () => { throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }); }, 0)).toBe(0);
    expect(await bestEffortAsync('record status', async () => { throw new Error('EBUSY lock'); })).toBeUndefined();
    await Promise.reject(new Error('settings.json locked')).catch(swallow('install hooks'));
    const text = await log('install hooks: settings.json locked');
    expect(text).toContain('[WARN] [best-effort] restore session s1: ENOENT spawn claude ENOENT');
    expect(text).toContain('[best-effort] record status: EBUSY lock');
    expect(text).toContain('[best-effort] install hooks: settings.json locked');
    expect(text).not.toContain('ok path');
  });
});
