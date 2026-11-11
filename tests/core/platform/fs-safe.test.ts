import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureFile, LOCK_RETRIES, lockWaitBudgetMs, withFileLock } from '../../../src/core/platform/fs-safe.js';

/** withFileLock: one holder at a time, and a wait long enough for holders that run git (checkpoints). */

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-safe-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('withFileLock', () => {
  it('waits about a minute for a lock someone holds — 20 tries gave up after ~8 s (five checkpoints at once failed)', () => {
    expect(lockWaitBudgetMs({ retries: 20, minTimeout: 25, maxTimeout: 500, factor: 2 })).toBeLessThan(9_000);
    expect(lockWaitBudgetMs(LOCK_RETRIES)).toBeGreaterThanOrEqual(60_000);
    expect(lockWaitBudgetMs(LOCK_RETRIES)).toBeLessThan(120_000);
  });

  it('one holder at a time: a second waits for the first, then runs', async () => {
    const file = path.join(dir, 'x.json');
    ensureFile(file, '{}');
    const order: string[] = [];
    let open!: () => void;
    const held = new Promise<void>((r) => (open = r));
    const first = withFileLock(file, async () => {
      order.push('first in');
      await held;
      order.push('first out');
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = withFileLock(file, () => void order.push('second'));
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(['first in']); // still waiting
    open();
    await Promise.all([first, second]);
    expect(order).toEqual(['first in', 'first out', 'second']);
  });
});
