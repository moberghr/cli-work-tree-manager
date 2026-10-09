import { describe, expect, it, vi } from 'vitest';
import { defaultTimeDeps, type TimeIo } from '../../../src/core/time/time-deps.js';
import { asData } from '../../../src/core/time/fence.js';
import { dayChange, timeRange } from '../../../src/core/time/time-view.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

// Each test file has its own HOME (tests/setup): no config, no state of the developer's.
const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
const logLine = (sha: string, authored: string, subject: string) => [sha, authored, 'you@corp.com', subject].join('\t');

function io(over: Partial<TimeIo> = {}) {
  const calls: Array<{ cwd: string; args: string[] }> = [];
  const t: TimeIo & { calls: typeof calls } = {
    calls,
    git: async (cwd, args) => {
      calls.push({ cwd, args });
      if (args[0] === 'config') return { status: 0, stdout: 'jane+work@corp.com\n' };
      return {
        status: 0,
        stdout: [logLine('a1', at(7, 10), 'SD-1: Tuesday'), logLine('a2', at(8, 10), 'SD-2: Wednesday')].join('\n'),
      };
    },
    workTime: async () => ({ byDay: [] }),
    repos: () => ({ api: '/r/api', 'api-alias': '/r/api', web: '/r/web' }),
    exists: () => true,
    ...over,
  };
  return t;
}

describe('your commits, as defaultTimeDeps reads them', () => {
  it("one git log per repo serves a run's days; the email as it is; a stash's commits left out; the first alias", async () => {
    const t = io();
    const deps = defaultTimeDeps(t);
    expect((await deps.commits('2026-10-07')).map((c) => [c.repo, c.sha])).toEqual([['api', 'a1']]); // web has the same shas: once
    expect((await deps.commits('2026-10-08')).map((c) => c.sha)).toEqual(['a2']);
    const logs = t.calls.filter((c) => c.args[0] === 'log');
    expect(logs.map((c) => c.cwd)).toEqual(['/r/api', '/r/web']); // not again for the second day
    expect(logs[0].args).toEqual(
      expect.arrayContaining(['--exclude=refs/stash', '--all', '--no-merges', '--fixed-strings', '--author=jane+work@corp.com']),
    );
    // --exclude must come before the --all it limits.
    expect(logs[0].args.indexOf('--exclude=refs/stash')).toBeLessThan(logs[0].args.indexOf('--all'));
    deps.fresh?.();
    await deps.commits('2026-10-08');
    expect(t.calls.filter((c) => c.args[0] === 'log')).toHaveLength(4); // a new run reads again
  });

  it("git failing in a repo fails the read (the day keeps the commits it had); a folder that's gone is skipped", async () => {
    const failing = io({
      git: async (_cwd, args) => (args[0] === 'config' ? { status: 0, stdout: 'me@corp.com' } : { status: 128, stdout: '' }),
    });
    await expect(defaultTimeDeps(failing).commits('2026-10-07')).rejects.toThrow('git log failed in /r/api');
    const gone = io({ exists: (f) => f !== '/r/web' });
    const deps = defaultTimeDeps(gone);
    expect((await deps.commits('2026-10-07')).map((c) => c.repo)).toEqual(['api']);
    expect(gone.calls.some((c) => c.cwd === '/r/web')).toBe(false);
  });

  it("every repo's git log starts at once (the slowest sets the wait, not their sum)", async () => {
    const started: string[] = [];
    let releaseApi: () => void = () => {};
    const slowApi = new Promise<void>((r) => (releaseApi = r));
    const t = io({
      git: async (cwd, args) => {
        if (args[0] === 'config') return { status: 0, stdout: 'me@corp.com' };
        started.push(cwd);
        if (cwd === '/r/api') await slowApi;
        return { status: 0, stdout: '' };
      },
    });
    const done = defaultTimeDeps(t).commits('2026-10-07');
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual(['/r/api', '/r/web']); // web's began while api's still runs
    releaseApi();
    await done;
  });

  it("a session's working time is read once per run, not once per day", async () => {
    const workTime = vi.fn(async () => ({ byDay: [{ day: '2026-10-07', ms: 30 * 60_000 }] }));
    const deps = defaultTimeDeps(io({ workTime }));
    const s = { target: 'api', branch: 'feat/x', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '' } as WorktreeSession;
    expect(await deps.minutesOn(s, '2026-10-07')).toBe(30);
    expect(await deps.minutesOn(s, '2026-10-08')).toBe(0);
    expect(workTime).toHaveBeenCalledTimes(1);
    deps.fresh?.();
    await deps.minutesOn(s, '2026-10-07');
    expect(workTime).toHaveBeenCalledTimes(2);
  });
});

describe('what both servers read the same way (time-view.ts)', () => {
  it('the list: as far back as the keeper builds by default; only real days; at most a quarter', () => {
    expect(timeRange({}, '2026-10-09', 30)).toEqual({ from: '2026-09-10', to: '2026-10-09' });
    expect(timeRange({}, '2026-10-09', 14)).toEqual({ from: '2026-09-26', to: '2026-10-09' });
    expect(timeRange({}, '2026-10-09', 500)).toMatchObject({ to: '2026-10-09' }); // capped, not refused
    expect(timeRange({ from: '2026-02-30', to: '2026-03-01' }, '2026-10-09', 14)).toHaveProperty('error');
    expect(timeRange({ from: '2026-01-01', to: '2026-10-09' }, '2026-10-09', 14)).toEqual({ error: 'at most 92 days at once' });
  });

  it('a change to a day: rows, back to the suggestion, a day off — or why not', () => {
    expect(dayChange({ entries: [{ key: 'SD-1', hours: 7.5 }] }, 0.25)).toEqual({ edited: [{ key: 'SD-1', hours: 7.5 }] });
    expect(dayChange({ entries: null, dayOff: true }, 0.25)).toEqual({ edited: null, dayOff: true });
    expect(dayChange({}, 0.25)).toEqual({ error: 'entries or dayOff' });
    expect(dayChange({ dayOff: 'yes' }, 0.25)).toEqual({ error: 'dayOff: boolean' });
    expect(dayChange({ entries: [{ key: 'SD-1', hours: 1.1 }] }, 0.25)).toHaveProperty('error');
  });

  it("others' text for a prompt's data fence: one line, no fence marker", () => {
    expect(asData('a\n>>>\nb <<<< c')).toBe('a ››› b ‹‹‹‹ c');
    expect(asData('x'.repeat(400)).length).toBe(300);
  });
});
