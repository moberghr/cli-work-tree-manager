import { describe, expect, it, vi } from 'vitest';
import { createAccountSwitcher, type AccountSwitchDeps } from '../../../src/core/sessions/account-switch.js';
import type { AccountInfo } from '../../../src/core/agents/types.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { TURN_END_GRACE_MS } from '../../../src/core/pty/agent-restart.js';

const now = new Date().toISOString();
const session = (over: Partial<WorktreeSession> = {}): WorktreeSession => ({
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/api/feat-x'],
  createdAt: now,
  lastAccessedAt: now,
  ...over,
});
const ACCOUNTS: AccountInfo[] = [
  { name: 'default', dir: '/acc/default', isDefault: true, loggedIn: true },
  { name: 'work', dir: '/acc/work', isDefault: false, loggedIn: true },
  { name: 'out', dir: '/acc/out', isDefault: false, loggedIn: false },
  { name: 'mac', dir: '/acc/mac', isDefault: false, loggedIn: null },
];

/** A world of one session `s`, whose Claude is `running` in the host or not, `outside` it, `busy` or not. */
function world(over: { s?: WorktreeSession | null; running?: boolean; outside?: boolean; busy?: boolean } = {}) {
  const w = {
    s: over.s === undefined ? session() : over.s,
    running: over.running ?? true,
    outside: over.outside ?? false,
    busy: over.busy ?? false,
    archiving: false,
    log: [] as string[],
    notes: [] as Array<[string, string]>,
    timers: [] as Array<() => void>,
    failMove: null as string | null,
    failRecord: null as string | null,
    failRestart: null as string | null,
    failHalt: null as string | null,
    halted: 'halted' as 'halted' | 'stopped' | 'gone',
    /** resume fails only while the session records the NEW account (so a rollback's resume still works) */
    failResumeOnAnyAccount: false,
  };
  const deps: AccountSwitchDeps = {
    session: (id) => (w.s && id === 'api:feat/x' ? w.s : null),
    beingArchived: () => w.archiving,
    accounts: (s) => ({ list: ACCOUNTS, current: s.account ?? 'default' }),
    switchFiles: async (s, to) => {
      w.log.push(`move ${s.account ?? 'default'}→${to}`);
      if (w.failMove) throw new Error(w.failMove);
      return { moved: ['a', 'b'] };
    },
    record: async (s, to) => {
      if (w.failRecord) throw new Error(w.failRecord);
      w.log.push(`record ${to}`);
      w.s = { ...s, account: to };
    },
    hostRuns: () => w.running,
    runningOutside: () => w.outside,
    busy: () => w.busy,
    halt: async () => {
      w.log.push('halt');
      if (w.failHalt) throw new Error(w.failHalt);
      return w.halted;
    },
    resume: async (_id, how) => {
      w.log.push(`resume ${how} on ${w.s?.account ?? 'default'}`);
      if (w.failRestart && (w.failResumeOnAnyAccount || w.s?.account)) throw new Error(w.failRestart);
    },
    note: (id, text, level) => w.notes.push([level, text]),
    later: (fn) => w.timers.push(fn),
  };
  return { w, sw: createAccountSwitcher(deps) };
}
const ID = 'api:feat/x';

describe('switchAccount refusals', () => {
  it('an unknown session, an archived one, one being archived', async () => {
    expect(await world({ s: null }).sw.switchAccount(ID, 'work')).toMatchObject({ ok: false, status: 404 });
    expect(await world({ s: session({ archivedAt: now }) }).sw.switchAccount(ID, 'work')).toMatchObject({
      ok: false,
      status: 409,
      error: expect.stringContaining('archived'),
    });
    const { w, sw } = world();
    w.archiving = true;
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: false, status: 409 });
    expect(w.log).toEqual([]);
  });

  it('an agent without accounts', async () => {
    const { sw } = world();
    const bare = createAccountSwitcher({ ...baseDeps(), accounts: () => null });
    expect(await bare.switchAccount(ID, 'work')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('accounts') });
    expect(sw).toBeDefined();
  });

  it('an unknown account, one not logged in; an unknown login state (null) is allowed', async () => {
    const a = world({ running: false });
    expect(await a.sw.switchAccount(ID, 'nope')).toMatchObject({ ok: false, status: 400, error: expect.stringContaining('no account') });
    expect(await a.sw.switchAccount(ID, 'out')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('logged in') });
    expect(a.w.log).toEqual([]);
    expect(await a.sw.switchAccount(ID, 'mac')).toMatchObject({ ok: true, outcome: 'recorded' });
  });

  it('the account it is on', async () => {
    const { w, sw } = world({ s: session({ account: 'work' }) });
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already') });
    // A row from before accounts is on the default.
    const b = world();
    expect(await b.sw.switchAccount(ID, 'default')).toMatchObject({ ok: false, status: 409 });
    expect(w.log).toEqual([]);
  });

  it('its Claude running in a terminal outside the host', async () => {
    const { w, sw } = world({ running: false, outside: true });
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('outside work') });
    expect(w.log).toEqual([]);
  });

  it('a switch already waiting for its turn', async () => {
    const { w, sw } = world({ busy: true });
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'queued' });
    expect(await sw.switchAccount(ID, 'mac')).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already waiting') });
    expect(w.log).toEqual([]);
  });
});

describe('switchAccount', () => {
  it('not running in the host: the files move and the account is recorded (the next start uses it), nothing restarted', async () => {
    const { w, sw } = world({ running: false });
    expect(await sw.switchAccount(ID, 'work')).toEqual({ ok: true, outcome: 'recorded', moved: 2 });
    expect(w.log).toEqual(['move default→work', 'record work']);
    expect(w.notes[0][1]).toContain('work');
  });

  it('idle in the host: moved, recorded, then restarted — on the NEW account (recorded before the restart)', async () => {
    const { w, sw } = world();
    expect(await sw.switchAccount(ID, 'work')).toEqual({ ok: true, outcome: 'switched', moved: 2 });
    // Stopped first, the files move only then, and it starts again on the NEW account (recorded before the resume).
    expect(w.log).toEqual(['halt', 'move default→work', 'record work', 'resume halted on work']);
    expect(w.notes).toEqual([['action', expect.stringContaining('restarted on it')]]);
  });

  it('working or waiting on you: queued, nothing touched until its turn ends; then it moves and restarts', async () => {
    const { w, sw } = world({ busy: true });
    expect(await sw.switchAccount(ID, 'work')).toEqual({ ok: true, outcome: 'queued' });
    expect(w.log).toEqual([]);
    expect(sw.waiting()).toEqual([{ id: ID, to: 'work' }]);
    expect(w.notes).toEqual([['info', expect.stringContaining('when its turn ends')]]);
    // Its turn ends (the status hook): after the grace, it is idle now.
    w.busy = false;
    sw.turnEnded(ID);
    w.timers.pop()!(); // the grace timer is the newest (the queue's own recheck was set when it was queued)
    await vi.waitFor(() => expect(w.log).toEqual(['halt', 'move default→work', 'record work', 'resume halted on work']));
    expect(sw.waiting()).toEqual([]);
    expect(w.notes.at(-1)).toEqual(['action', expect.stringContaining('restarted on it')]);
    expect(TURN_END_GRACE_MS).toBeGreaterThan(0);
  });

  it('a queued switch whose Claude stopped meanwhile still records the account (not dropped as "stopped")', async () => {
    const { w, sw } = world({ busy: true });
    await sw.switchAccount(ID, 'work');
    w.running = false;
    w.busy = false;
    await sw.retry();
    expect(w.log).toEqual(['move default→work', 'record work']);
    expect(w.s?.account).toBe('work');
  });

  it('a still-busy session at its turn end is looked at again, not switched under it', async () => {
    const { w, sw } = world({ busy: true });
    await sw.switchAccount(ID, 'work');
    sw.turnEnded(ID);
    w.timers.pop()!();
    await Promise.resolve();
    expect(w.log).toEqual([]);
    expect(sw.waiting()).toHaveLength(1);
  });
});

describe('stop → move → start', () => {
  it('the move happens only after the halt, and the resume only after the record', async () => {
    const { w, sw } = world();
    await sw.switchAccount(ID, 'work');
    const at = (x: string) => w.log.findIndex((l) => l.startsWith(x));
    expect(at('halt')).toBeLessThan(at('move'));
    expect(at('move')).toBeLessThan(at('record'));
    expect(at('record')).toBeLessThan(at('resume'));
  });

  it('a halt that fails (its Claude would not stop): nothing moved, nothing recorded, stays on the old account', async () => {
    const { w, sw } = world();
    w.failHalt = 'its agent did not stop within 3 s';
    const r = await sw.switchAccount(ID, 'work');
    expect(r).toMatchObject({ ok: false, status: 502, error: expect.stringContaining("stays on default: couldn't stop its Claude") });
    expect(w.log).toEqual(['halt']);
    expect(w.s?.account).toBeUndefined();
  });

  it('an older host (halt stopped it the old way): moved and recorded, then started from a fresh spec', async () => {
    const { w, sw } = world();
    w.halted = 'stopped';
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'switched' });
    expect(w.log).toEqual(['halt', 'move default→work', 'record work', 'resume stopped on work']);
  });

  it('nothing was running by the time it was halted (gone): the files move and the account is recorded, nothing resumed', async () => {
    const { w, sw } = world();
    w.halted = 'gone';
    // Asked while it ran (so 'switched'), but nothing is left to start: the next start uses the new account.
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'switched' });
    expect(w.log).toEqual(['halt', 'move default→work', 'record work']);
  });

  it('a failed move and a Claude that then cannot be started again: said, with the old account kept', async () => {
    const { w, sw } = world();
    w.failMove = 'EBUSY';
    w.failRestart = 'spawn failed';
    w.failResumeOnAnyAccount = true;
    const r = await sw.switchAccount(ID, 'work');
    expect(r).toMatchObject({ ok: false, status: 502, error: expect.stringContaining("couldn't start its Claude again") });
    expect(r.ok === false && r.error).toContain('stays on default');
    expect(w.s?.account).toBeUndefined();
  });
});

describe('a failure keeps the old account', () => {
  it('a move that fails: nothing recorded, no restart, its Claude goes on running on the old account', async () => {
    const { w, sw } = world();
    w.failMove = 'EBUSY: resource busy';
    const r = await sw.switchAccount(ID, 'work');
    expect(r).toMatchObject({ ok: false, status: 502, error: expect.stringContaining('stays on default') });
    expect(r.ok === false && r.error).toContain('EBUSY');
    // Halted, the move failed (and rolled itself back): resumed on the OLD account.
    expect(w.log).toEqual(['halt', 'move default→work', 'resume halted on default']);
    expect(w.s?.account).toBeUndefined();
    expect(w.notes).toEqual([['warn', expect.stringContaining("couldn't switch")]]);
    // And it can be tried again.
    w.failMove = null;
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'switched' });
  });

  it('a move that fails while not running: the old account stays, 502', async () => {
    const { w, sw } = world({ running: false });
    w.failMove = 'EACCES';
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({
      ok: false,
      status: 502,
      error: expect.stringContaining('stays on default'),
    });
    expect(w.log).toEqual(['move default→work']);
  });

  it('a record that fails after the move: the files are put back', async () => {
    const { w, sw } = world();
    w.failRecord = 'database is locked';
    const r = await sw.switchAccount(ID, 'work');
    expect(r).toMatchObject({ ok: false, status: 502, error: expect.stringContaining('database is locked') });
    expect(w.log).toEqual(['halt', 'move default→work', 'move work→default', 'resume halted on default']);
  });

  it('a queued switch whose move fails when its turn ends is reported, and nothing stays pending', async () => {
    const { w, sw } = world({ busy: true });
    await sw.switchAccount(ID, 'work');
    w.failMove = 'EBUSY';
    w.busy = false;
    await sw.retry();
    expect(w.notes.at(-1)).toEqual(['warn', expect.stringContaining('stays on default')]);
    expect(sw.waiting()).toEqual([]);
    expect(w.s?.account).toBeUndefined();
  });

  it('a restart that fails after the move: the account is recorded (the next start uses it), and it says so', async () => {
    const { w, sw } = world();
    w.failRestart = 'its agent did not stop';
    const r = await sw.switchAccount(ID, 'work');
    expect(r).toMatchObject({
      ok: false,
      status: 502,
      error: expect.stringContaining("moved to the work account, but its Claude couldn't be restarted"),
    });
    expect(w.s?.account).toBe('work');
    expect(w.notes).toEqual([['warn', expect.stringContaining('opening the session starts it on work')]]);
  });

  it('an older host (it restarted by stopping and starting): its note is kept in the outcome text', async () => {
    const world1 = world();
    const sw = createAccountSwitcher({ ...baseDeps(world1.w), resume: async () => 'stopped and started again (an older PTY host)' });
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'switched' });
    expect(world1.w.notes[0][1]).toContain('an older PTY host');
  });
});

/** The deps of a world, to override one in a test. */
function baseDeps(w = world().w): AccountSwitchDeps {
  return {
    session: () => w.s,
    beingArchived: () => false,
    accounts: (s) => ({ list: ACCOUNTS, current: s.account ?? 'default' }),
    switchFiles: async () => ({ moved: ['a'] }),
    record: async (s, to) => void (w.s = { ...s, account: to }),
    hostRuns: () => true,
    runningOutside: () => false,
    busy: () => false,
    halt: async () => 'halted',
    resume: async () => {},
    note: (id, text, level) => w.notes.push([level, text]),
    later: (fn) => w.timers.push(fn),
  };
}

describe('a rollback that fails is said (review W5)', () => {
  it('a record that fails and a move back that fails too: both in the answer and the Activity note, stuck paths included', async () => {
    const { w, sw } = world();
    w.failRecord = 'database is locked';
    const sw2 = createAccountSwitcher({
      ...baseDeps(w),
      switchFiles: async (s, to) => {
        if ((s.account ?? 'default') === 'work' && to === 'default')
          throw new Error("couldn't move its conversations: 1 put back, 1 could not be: /acc/work/projects/x");
        return { moved: ['a'] };
      },
      record: async () => {
        throw new Error('database is locked');
      },
    });
    const r = await sw2.switchAccount(ID, 'work');
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(r.ok === false && r.error).toContain('database is locked');
    expect(r.ok === false && r.error).toContain("couldn't all be moved back");
    expect(r.ok === false && r.error).toContain('/acc/work/projects/x');
    expect(w.notes.at(-1)).toEqual(['warn', expect.stringContaining('/acc/work/projects/x')]);
    expect(sw).toBeDefined();
  });
});

describe('another Claude in its folders, an older PTY host (review W2, W4)', () => {
  it('refused before anything stops when another Claude runs in one of the folders it would move', async () => {
    const { w } = world();
    const sw = createAccountSwitcher({
      ...baseDeps(w),
      halt: async () => {
        w.log.push('halt');
        return 'halted';
      },
      othersRunningIn: () => '/wt/api/feat-x',
    });
    const r = await sw.switchAccount(ID, 'work');
    expect(r).toMatchObject({
      ok: false,
      status: 409,
      error: 'stays on default: a Claude outside this session runs in /wt/api/feat-x',
    });
    expect(w.log).toEqual([]);
    expect(w.s?.account).toBeUndefined();
  });

  it('a queued switch finding another Claude there when its turn ends: not done, said, nothing stopped', async () => {
    const { w } = world({ busy: true });
    let other: string | null = null;
    const sw = createAccountSwitcher({
      ...baseDeps(w),
      busy: () => w.busy,
      halt: async () => {
        w.log.push('halt');
        return 'halted';
      },
      othersRunningIn: () => other,
    });
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ outcome: 'queued' });
    other = '/wt/api/feat-x';
    w.busy = false;
    await sw.retry();
    expect(w.log).toEqual([]);
    expect(w.notes.at(-1)).toEqual(['warn', expect.stringContaining('a Claude outside this session runs in /wt/api/feat-x')]);
    expect(sw.waiting()).toEqual([]);
  });

  it('a PTY host from before accounts: refused before halting, nothing changed; not asked when it does not run in the host', async () => {
    const { w } = world();
    const asked: string[] = [];
    const deps = {
      ...baseDeps(w),
      halt: async () => {
        w.log.push('halt');
        return 'halted' as const;
      },
      hostRefusal: async () => {
        asked.push('host');
        return 'the PTY host is from before Claude accounts: run `work pty-host --restart`';
      },
    };
    const r = await createAccountSwitcher(deps).switchAccount(ID, 'work');
    expect(r).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('work pty-host --restart') });
    expect(w.log).toEqual([]);
    expect(w.s?.account).toBeUndefined();
    // Not in the host: nothing to start there now, the account is recorded (the next start says it, ensurePty).
    const r2 = await createAccountSwitcher({ ...deps, hostRuns: () => false }).switchAccount(ID, 'work');
    expect(r2).toMatchObject({ ok: true, outcome: 'recorded' });
    expect(asked).toEqual(['host']);
  });
});

describe('a switch waiting for its turn: shown and cancellable (review W6)', () => {
  it('pendingFor names where it goes while queued; cancel drops it, says so, and its turn end then does nothing', async () => {
    const { w, sw } = world({ busy: true });
    expect(sw.pendingFor(ID)).toBeNull();
    await sw.switchAccount(ID, 'work');
    expect(sw.pendingFor(ID)).toBe('work');
    expect(sw.cancel(ID)).toBe('cancelled');
    expect(sw.pendingFor(ID)).toBeNull();
    expect(sw.waiting()).toEqual([]);
    expect(w.notes.at(-1)).toEqual(['info', expect.stringContaining('cancelled')]);
    w.busy = false;
    await sw.retry();
    expect(w.log).toEqual([]);
    expect(w.s?.account).toBeUndefined();
    // Nothing waits now; and it can be asked again.
    expect(sw.cancel(ID)).toBe('none');
    expect(await sw.switchAccount(ID, 'work')).toMatchObject({ ok: true, outcome: 'switched' });
  });

  it('a switch being done right now is not cancelled', async () => {
    const { w } = world();
    let release!: () => void;
    const sw = createAccountSwitcher({
      ...baseDeps(w),
      halt: () => new Promise((r) => (release = () => r('halted'))),
    });
    const going = sw.switchAccount(ID, 'work');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(sw.cancel(ID)).toBe('running');
    release();
    expect(await going).toMatchObject({ ok: true, outcome: 'switched' });
  });
});

describe('accountSwitchNote: the Activity panel (review W6)', () => {
  it('one run per note; a failure fails the run (the dot lights), the rest are done', async () => {
    const { accountSwitchNote } = await import('../../../src/core/sessions/account-switch.js');
    const runs: Array<{ notes: Array<[string, unknown]>; end?: [string, string] }> = [];
    const activity = {
      start: () => {
        const r: (typeof runs)[number] = { notes: [] };
        runs.push(r);
        return {
          note: (text: string, o?: unknown) => void r.notes.push([text, o]),
          done: (t?: string) => void (r.end = ['done', t ?? '']),
          fail: (t: string) => void (r.end = ['fail', t]),
          progress: () => {},
        };
      },
    };
    const note = accountSwitchNote(activity as never, (id) => (id === ID ? 'api feat/x' : null));
    note(ID, 'will move to the work account when its turn ends', 'info');
    note(ID, "couldn't switch: stays on default: EBUSY", 'warn');
    note('gone', 'moved', 'action');
    expect(runs.map((r) => r.end?.[0])).toEqual(['done', 'fail', 'done']);
    expect(runs[1].end?.[1]).toContain('EBUSY');
    expect(runs[1].notes[0]).toEqual(["api feat/x: couldn't switch: stays on default: EBUSY", { level: 'warn', sessionId: ID }]);
    expect(runs[2].notes[0]).toEqual(['gone: moved', { level: 'action', sessionId: undefined }]);
  });
});
