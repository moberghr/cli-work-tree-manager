import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DiffStatCache, parseNumstat, wantsDiffStat } from '../../src/core/diff-stat.js';
import type { CommandRunner } from '../../src/core/ship.js';
import type { WorktreeSession } from '../../src/core/history.js';

describe('parseNumstat', () => {
  it('sums lines and counts files; binary files count as files only', () => {
    expect(parseNumstat('3\t1\ta.ts\n10\t0\tb.ts\n-\t-\tlogo.png\n\n')).toEqual({ added: 13, deleted: 1, files: 3 });
    expect(parseNumstat('')).toEqual({ added: 0, deleted: 0, files: 0 });
  });
});

describe('DiffStatCache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffstat-'));
  let calls = 0;
  let numstat = '2\t1\ta.ts\n';
  const run: CommandRunner = async (_cmd, args) => {
    calls++;
    if (args[0] === 'diff') return { code: 0, stdout: numstat, stderr: '' };
    return { code: 0, stdout: 'new.ts\n', stderr: '' }; // ls-files --others
  };

  it('never blocks: first read is null, then the computed value; changes are signalled once', async () => {
    let changes = 0;
    let now = 1000;
    const cache = new DiffStatCache({ run, ttlMs: 100, onChange: () => changes++, now: () => now });
    expect(cache.get('s', [dir])).toBeNull();
    await cache.idle();
    expect(cache.get('s', [dir])).toEqual({ added: 2, deleted: 1, files: 2 });
    expect(changes).toBe(1);

    // Within the TTL: served from cache, no git.
    const before = calls;
    cache.get('s', [dir]);
    await cache.idle();
    expect(calls).toBe(before);

    // Past the TTL with the same result: recomputed, but no change signal.
    now += 200;
    cache.get('s', [dir]);
    await cache.idle();
    expect(calls).toBeGreaterThan(before);
    expect(changes).toBe(1);

    // invalidate() forces a refresh; a different result signals.
    numstat = '5\t0\ta.ts\n';
    cache.invalidate('s');
    cache.get('s', [dir]);
    await cache.idle();
    expect(cache.get('s', [dir])).toEqual({ added: 5, deleted: 0, files: 2 });
    expect(changes).toBe(2);
  });

  it('is null for worktrees that no longer exist', async () => {
    const cache = new DiffStatCache({ run });
    cache.get('gone', [path.join(dir, 'nope')]);
    await cache.idle();
    expect(cache.get('gone', [path.join(dir, 'nope')])).toBeNull();
  });
});

describe('wantsDiffStat', () => {
  const s = (over: Partial<WorktreeSession>) =>
    ({ target: 't', branch: 'b', isGroup: false, paths: [], createdAt: '', lastAccessedAt: new Date().toISOString(), ...over }) as WorktreeSession;
  it('skips archived and long-untouched sessions unless they report a status', () => {
    expect(wantsDiffStat(s({}), false)).toBe(true);
    expect(wantsDiffStat(s({ archivedAt: 'x' }), true)).toBe(false);
    const old = s({ lastAccessedAt: '2020-01-01T00:00:00Z' });
    expect(wantsDiffStat(old, false)).toBe(false);
    expect(wantsDiffStat(old, true)).toBe(true);
  });
});
