import { describe, expect, it, vi } from 'vitest';
import { createRestarter, TURN_END_GRACE_MS } from '../../../src/core/pty/agent-restart.js';
import { createAccountSwitcher, type AccountSwitchDeps } from '../../../src/core/sessions/account-switch.js';
import { createAccountSwitchLink } from '../../../src/core/sessions/account-switch-link.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/**
 * The agent restarter and the account switcher as work web ties them (account-switch-link.ts): the real two, over fake
 * I/O and a clock of our own. One agent is restarted once, whichever was asked first (T6); a turn's end and the sweep
 * reach the restarter through the link (T5). A switch goes at once, so only a restart ever waits for a turn.
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
  const gate = { hold: null as Promise<void> | null };
  const halt = vi.fn(async () => {
    await gate.hold;
    return 'halted' as const;
  });
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
  return { state, notes, link, restarter, switcher, restart, halt, run, timers, gate };
}

describe('a switch of account and an agent restart on one session (T6)', () => {
  it('a restart waiting for the turn, then a switch: the switch goes at once (mid-turn) and drops the waiting restart', async () => {
    const w = world();
    expect((await w.restarter.request([ID])).later).toEqual([ID]);
    expect(await w.switcher.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'switched', interrupted: true });
    expect(w.halt).toHaveBeenCalledTimes(1);
    expect(w.restarter.queued()).toEqual([]);
    expect(w.notes, w.notes.join(' | ')).toContain('switch: its agent restart that waited for this turn is done by the switch instead');
    // Its turn's end then restarts nothing.
    w.state.busy = false;
    w.link.turnEnded(ID);
    await w.run();
    expect(w.restart).not.toHaveBeenCalled();
  });

  it('a switch being done, then a restart asked: folded into the switch (answered as waiting, never queued)', async () => {
    const w = world();
    let release!: () => void;
    w.gate.hold = new Promise((r) => (release = r));
    const going = w.switcher.switchAccount(ID, 'work');
    await vi.waitFor(() => expect(w.halt).toHaveBeenCalledTimes(1));
    const r = await w.restarter.request([ID]);
    expect(r).toEqual({ now: [], later: [ID], failed: [] });
    expect(w.restarter.queued()).toEqual([]);
    expect(w.notes).toContain('restarter: restarts with its switch to the work account (no second restart)');
    release();
    expect((await going).ok).toBe(true);
    expect(w.restart).not.toHaveBeenCalled();
    expect(w.link.foldedInto(ID)).toBeNull();
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
  it('turnEnded and retry reach the restarter; retry never rejects, and before connect everything is a no-op', async () => {
    const link = createAccountSwitchLink();
    expect(link.cancelRestart(ID)).toBe(false);
    expect(link.foldedInto(ID)).toBeNull();
    link.turnEnded(ID);
    await expect(link.retry()).resolves.toBeUndefined();
    const failing = {
      turnEnded: vi.fn(),
      retry: vi.fn(async () => {
        throw new Error('x');
      }),
      cancel: vi.fn(() => true),
    };
    link.connect(failing, { restartsAnyway: vi.fn(() => 'work') });
    await expect(link.retry()).resolves.toBeUndefined();
    expect(failing.retry).toHaveBeenCalled();
    link.turnEnded(ID);
    expect(failing.turnEnded).toHaveBeenCalledWith(ID);
    expect(link.cancelRestart(ID)).toBe(true);
    expect(link.foldedInto(ID)).toBe('its switch to the work account');
  });
});
