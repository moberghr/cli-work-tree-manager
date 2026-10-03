import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAMES_MAX_AGE_MS, projectTranscripts } from '../../../src/core/agents/claude/activity.js';
import { firstPromptOf } from '../../../src/core/conversations/session-title.js';
import { claudeEntries } from '../../../src/core/agents/claude/entries.js';
import { recentProcessTable } from '../../../src/core/platform/process.js';
import { createSerialQueue, throttleTrailing } from '../../../src/core/platform/throttle.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'res-caches-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('projectTranscripts', () => {
  it('sees a new transcript within the max age (at once when the folder time moved), its growth at once, its removal', () => {
    let t = 1_000_000;
    const later = () => (t += NAMES_MAX_AGE_MS); // NTFS may not move the folder's mtime at once
    const proj = path.join(dir, 'proj');
    expect(projectTranscripts(proj, t)).toEqual([]); // no folder yet
    fs.mkdirSync(proj);
    expect(projectTranscripts(proj, t)).toEqual([]);
    const f = path.join(proj, 'a.jsonl');
    fs.writeFileSync(f, 'x');
    fs.writeFileSync(path.join(proj, 'notes.txt'), 'not a transcript');
    expect(projectTranscripts(proj, later()).map((x) => [path.basename(x.file), x.size])).toEqual([['a.jsonl', 1]]);
    fs.appendFileSync(f, 'yz');
    expect(projectTranscripts(proj, t)[0].size).toBe(3); // sizes are always fresh
    fs.rmSync(f);
    expect(projectTranscripts(proj, later())).toEqual([]);
  });

  it('within the max age, an unchanged folder is not read again', () => {
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, 'a.jsonl'), 'x');
    const t = 5_000_000;
    projectTranscripts(proj, t);
    const readdir = vi.spyOn(fs, 'readdirSync');
    projectTranscripts(proj, t + 10);
    projectTranscripts(proj, t + 20);
    expect(readdir).not.toHaveBeenCalled();
    projectTranscripts(proj, t + NAMES_MAX_AGE_MS);
    expect(readdir).toHaveBeenCalledTimes(1);
  });
});

describe('firstPromptOf', () => {
  it('remembers "no prompt in it" while the file is unchanged', () => {
    const f = path.join(dir, 't.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    expect(firstPromptOf(f, claudeEntries)).toBeNull();
    const open = vi.spyOn(fs, 'openSync');
    expect(firstPromptOf(f, claudeEntries)).toBeNull();
    expect(open).not.toHaveBeenCalled();
    fs.appendFileSync(f, JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-30T10:00:00Z', message: { role: 'user', content: 'Fix the login redirect' } }) + '\n');
    expect(firstPromptOf(f, claudeEntries)).toBe('Fix the login redirect'); // it grew: read again
  });
});

describe('recentProcessTable', () => {
  it('never waits: null at first, then the table from a background refresh', async () => {
    const first = recentProcessTable(60_000);
    await vi.waitFor(() => expect(recentProcessTable(60_000)?.has(process.pid)).toBe(true), { timeout: 15_000 });
    expect(first === null || first.has(process.pid)).toBe(true);
  }, 20_000);
});

describe('throttleTrailing', () => {
  it('the first call at once, a burst as one call at the end of the window', () => {
    let t = 0;
    const timers: Array<{ at: number; cb: () => void }> = [];
    const calls: number[] = [];
    const f = throttleTrailing(() => calls.push(t), 750, { now: () => t, setTimeout: (cb, ms) => timers.push({ at: t + ms, cb }) });
    f(); // t=0: at once
    t = 100; f();
    t = 200; f();
    t = 300; f();
    expect(calls).toEqual([0]);
    expect(timers).toHaveLength(1);
    t = 750; timers[0].cb();
    expect(calls).toEqual([0, 750]);
    t = 2000; f(); // a quiet window later: at once again
    expect(calls).toEqual([0, 750, 2000]);
  });
});

describe('createSerialQueue', () => {
  it('one job at a time, in order; a failure does not stop the next', async () => {
    const run = createSerialQueue();
    const log: string[] = [];
    const job = (n: string, fail = false) => async () => {
      log.push(`${n}+`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`${n}-`);
      if (fail) throw new Error(n);
      return n;
    };
    const a = run(job('a', true));
    const b = run(job('b'));
    await expect(a).rejects.toThrow('a');
    expect(await b).toBe('b');
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-']);
  });
});
