import { describe, expect, it } from 'vitest';
import { describeStall, watchLoop, type Stall } from '../../src/server/loop-watch.js';
import { commandName, noteSyncWork, takeSlowestSync, timedSync } from '../../src/core/platform/sync-work.js';

const block = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* a synchronous job holding the loop */
  }
};

describe('watchLoop', () => {
  it('reports a stall past the threshold, with the slowest request meanwhile — and nothing when the loop is free', async () => {
    const stalls: Stall[] = [];
    const w = watchLoop({ everyMs: 150, thresholdMs: 100, onStall: (s) => stalls.push(s) });
    await new Promise((r) => setTimeout(r, 400)); // free: nothing
    expect(stalls).toEqual([]);
    w.request('GET /api/sessions', 30); // fast: not remembered
    w.request('POST /api/sessions/x/archive', 320);
    block(300);
    await new Promise((r) => setTimeout(r, 400));
    w.stop();
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].blockedMs).toBeGreaterThanOrEqual(200);
    expect(stalls[0].slowest).toEqual({ what: 'POST /api/sessions/x/archive', ms: 320 });
  });

  it('says it in one line', () => {
    expect(describeStall({ blockedMs: 2400, slowest: { what: 'GET /api/digest', ms: 2300 } })).toBe(
      'the server was blocked for 2.4 s (status updates, terminals and notifications waited); slowest request: GET /api/digest (2.3 s)',
    );
    // With no slow request (most stalls: a timer's job), the command it ran itself is the answer.
    expect(describeStall({ blockedMs: 23_900, slowest: null, ran: { what: 'git worktree remove C:\\wt\\x', ms: 23_800 } })).toBe(
      'the server was blocked for 23.9 s (status updates, terminals and notifications waited); it ran: git worktree remove C:\\wt\\x (23.8 s)',
    );
  });

  it('a stall names the slowest synchronous command the server ran in that window; one from a quiet window is never blamed later', async () => {
    const stalls: Stall[] = [];
    const queue: Array<{ what: string; ms: number } | null> = [{ what: 'tasklist', ms: 900 }];
    const asked: number[] = [];
    const w = watchLoop({
      everyMs: 150,
      thresholdMs: 100,
      onStall: (s) => stalls.push(s),
      ran: () => (asked.push(1), queue.shift() ?? null),
    });
    // A quiet window takes (and drops) what ran in it.
    await new Promise((r) => setTimeout(r, 250));
    expect(stalls).toEqual([]);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    queue.push({ what: 'git worktree remove', ms: 310 });
    block(300);
    await new Promise((r) => setTimeout(r, 400));
    w.stop();
    expect(stalls[0].ran).toEqual({ what: 'git worktree remove', ms: 310 });
  });
});

describe('sync-work: the slowest synchronous command lately', () => {
  it('keeps the slowest slow one until taken; a quick one is not worth naming', () => {
    takeSlowestSync();
    noteSyncWork('git status', 40);
    expect(takeSlowestSync()).toBeNull();
    noteSyncWork('git fetch', 900);
    noteSyncWork('tasklist', 1400);
    noteSyncWork('git log', 300);
    expect(takeSlowestSync()).toEqual({ what: 'tasklist', ms: 1400 });
    expect(takeSlowestSync()).toBeNull();
  });

  it('timedSync notes a slow run under its name (asked for only then), returns what it ran, and notes a throw too', () => {
    takeSlowestSync();
    const named: string[] = [];
    expect(
      timedSync(
        () => (named.push('quick'), 'quick'),
        () => 7,
      ),
    ).toBe(7);
    expect(named).toEqual([]);
    expect(
      timedSync(
        () => 'slow job',
        () => (block(300), 'done'),
      ),
    ).toBe('done');
    expect(takeSlowestSync()?.what).toBe('slow job');
    expect(() =>
      timedSync(
        () => 'slow failure',
        () => {
          block(300);
          throw new Error('boom');
        },
      ),
    ).toThrow('boom');
    expect(takeSlowestSync()?.what).toBe('slow failure');
  });

  it('names a command by its program and first arguments, never all of them', () => {
    expect(commandName(['C:\\Program Files\\Git\\cmd\\git.exe', ['worktree', 'remove', 'C:\\wt\\x', '--force']])).toBe(
      'git worktree remove C:\\wt\\x',
    );
    expect(commandName(['gh', ['pr', 'view']])).toBe('gh pr view');
    expect(commandName(['npm run dev', { shell: true }])).toBe('npm run dev');
  });
});
