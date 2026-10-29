import { describe, expect, it, vi } from 'vitest';
import { createRestarter, TURN_END_GRACE_MS } from '../../../src/core/pty/agent-restart.js';
import { createAccountSwitcher, type AccountSwitchDeps } from '../../../src/core/sessions/account-switch.js';
import { createAccountSwitchLink } from '../../../src/core/sessions/account-switch-link.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/**
 * The agent restarter and the account switcher as work web ties them (account-switch-link.ts): the real two, over fake
 * I/O and a clock of our own. One agent is restarted once for one turn, whichever was asked first (T6), and a turn's end,
 * the sweep and the session rows reach the switcher through the link (T5).
 */

const ID = 'api:feat/x';
const session = {
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/api'],
  createdAt: '',
  lastAccessedAt: '',
} as WorktreeSession;

function world() {
  // Only the looks a turn's end asks for (TURN_END_GRACE_MS) are run by hand; the restarters' periodic re-looks wait.
  const timers: Array<() => void> = [];
  const later = (fn: () => void, ms: number) => void (ms === TURN_END_GRACE_MS && timers.push(fn));
  const state = { busy: true };
  const notes: string[] = [];
  const link = createAccountSwitchLink();
  const restart = vi.fn(async () => undefined);
  const restarter = createRestarter({
    restart,
    busy: () => state.busy,
    running: () => true,
    later,
    foldedInto: link.foldedInto,
    report: (n) => notes.push(...n.map((x) => `restarter: ${x.text}`)),
  });
  const halt = vi.fn(async () => 'halted' as const);
  const deps: AccountSwitchDeps = {
    session: () => session,
    beingArchived: () => false,
    accounts: () => ({
      list: [
        { name: 'default', dir: '/a', isDefault: true, loggedIn: true },
        { name: 'work', dir: '/b', isDefault: false, loggedIn: true },
      ],
      current: 'default',
    }),
    switchFiles: vi.fn(async () => ({ moved: [] })),
    record: vi.fn(async () => {}),
    hostRuns: () => true,
    runningOutside: () => false,
    busy: () => state.busy,
    halt,
    resume: vi.fn(async () => undefined),
    note: (_id, text) => void notes.push(`switch: ${text}`),
    later,
    cancelRestart: link.cancelRestart,
  };
  const switcher = createAccountSwitcher(deps);
  link.connect(restarter, switcher);
  const settle = async () => {
    for (let n = 0; n < 20; n++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  /** Run what is due, in the order given (indexes into the timers as they are now), each one settled before the next. */
  const run = async (order?: number[]) => {
    const due = timers.splice(0);
    for (const i of order ?? due.map((_, n) => n)) {
      due[i]!();
      await settle();
    }
  };
  return { state, notes, link, restarter, switcher, restart, halt, run, timers };
}

describe('a switch of account and an agent restart on one session (T6)', () => {
  it('restart asked first, then a switch: when the turn ends and the switch goes first, it drops the waiting restart', async () => {
    const w = world();
    expect((await w.restarter.request([ID])).later).toEqual([ID]);
    expect((await w.switcher.switchAccount(ID, 'work')).ok).toBe(true);
    expect(w.restarter.queued()).toEqual([ID]);
    w.state.busy = false;
    w.link.turnEnded(ID);
    expect(w.timers).toHaveLength(2); // the restarter's look, then the switcher's
    await w.run([1, 0]); // the switch's turn comes first
    expect(w.halt).toHaveBeenCalledTimes(1);
    expect(w.restart).not.toHaveBeenCalled();
    expect(w.restarter.queued()).toEqual([]);
    expect(w.notes, w.notes.join(' | ')).toContain('switch: its agent restart that waited for this turn is done by the switch instead');
  });

  it('restart asked first, then a switch: when the restarter looks first, it sees the switch coming and stands down', async () => {
    const w = world();
    await w.restarter.request([ID]);
    await w.switcher.switchAccount(ID, 'work');
    w.state.busy = false;
    w.link.turnEnded(ID);
    await w.run([0, 1]);
    expect(w.restart).not.toHaveBeenCalled();
    expect(w.halt).toHaveBeenCalledTimes(1);
    expect(w.notes.some((n) => n.startsWith('restarter: no longer waits to restart: its switch to the work account restarts it'))).toBe(
      true,
    );
  });

  it('a switch waiting, then a restart asked: folded into the switch (answered as waiting, never queued twice)', async () => {
    const w = world();
    expect(await w.switcher.switchAccount(ID, 'work')).toEqual({ ok: true, outcome: 'queued' });
    const r = await w.restarter.request([ID]);
    expect(r).toEqual({ now: [], later: [ID], failed: [] });
    expect(w.restarter.queued()).toEqual([]);
    expect(w.notes).toContain('restarter: restarts with its switch to the work account (no second restart)');
    w.state.busy = false;
    w.link.turnEnded(ID);
    await w.run();
    expect(w.halt).toHaveBeenCalledTimes(1);
    expect(w.restart).not.toHaveBeenCalled();
  });

  it('with no switch about, a restart is a restart', async () => {
    const w = world();
    w.state.busy = false;
    expect((await w.restarter.request([ID])).now).toEqual([ID]);
    expect(w.restart).toHaveBeenCalledTimes(1);
    expect(w.link.foldedInto(ID)).toBeNull();
  });
});

describe('the link: what work web wires through it (T5)', () => {
  it('pendingFor names where a waiting switch goes; turnEnded and retry reach both', async () => {
    const w = world();
    expect(w.link.pendingFor(ID)).toBeNull();
    await w.switcher.switchAccount(ID, 'work');
    expect(w.link.pendingFor(ID)).toBe('work');
    // The sweep: a turn whose end no hook reported — not busy any more, the switch goes.
    w.state.busy = false;
    await w.link.retry();
    await w.run();
    expect(w.halt).toHaveBeenCalledTimes(1);
    expect(w.link.pendingFor(ID)).toBeNull();
  });

  it('retry never rejects, and before connect everything is a no-op', async () => {
    const link = createAccountSwitchLink();
    expect(link.pendingFor(ID)).toBeNull();
    expect(link.cancelRestart(ID)).toBe(false);
    expect(link.foldedInto(ID)).toBeNull();
    link.turnEnded(ID);
    await expect(link.retry()).resolves.toBeUndefined();
    const failing = {
      turnEnded: vi.fn(),
      retry: vi.fn(async () => {
        throw new Error('x');
      }),
      cancel: vi.fn(() => false),
    };
    const sw = { turnEnded: vi.fn(), retry: vi.fn(async () => {}), pendingFor: vi.fn(() => null), restartsAnyway: vi.fn(() => null) };
    link.connect(failing, sw);
    await expect(link.retry()).resolves.toBeUndefined();
    expect(sw.retry).toHaveBeenCalled();
    link.turnEnded(ID);
    expect(failing.turnEnded).toHaveBeenCalledWith(ID);
    expect(sw.turnEnded).toHaveBeenCalledWith(ID);
  });
});
