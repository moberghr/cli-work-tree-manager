import { afterEach, describe, expect, it } from 'vitest';
import type { LiveAgent } from '../../../src/core/agents/types.js';
import { dbPtySessions } from '../../../src/core/pty/pty-sessions-file.js';
import { loadHistory, saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { clearLaunchedUnsafeWhenIdle, legacyUnsafeCheck, runsUnsafeFromBefore } from '../../../src/core/sessions/legacy-unsafe-io.js';

/** The legacy --unsafe rule read from state.db (a real restore entry) and the running agents (injected). Remove next release. */

const s: WorktreeSession = {
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/x'],
  createdAt: 'x',
  lastAccessedAt: 'x',
  launchedUnsafe: true,
};
const id = sessionIdFor(s);
const tool = { cmd: 'claude', flags: [], resumeFlag: '--continue' };
const agent = (pid: number, cwd = '/wt/x'): LiveAgent => ({
  pid,
  conversationId: `c${pid}`,
  cwd,
  busy: false,
  state: 'idle',
  stateAt: null,
  waitingFor: null,
  startedAt: null,
});

afterEach(() => {
  dbPtySessions.write({});
  saveHistory([]);
});

describe('runsUnsafeFromBefore', () => {
  it('a direct launch from before still running outside the host keeps the guard beside a new host entry without `unsafe` (N1)', () => {
    saveHistory([s]);
    dbPtySessions.write({ [id]: { cwd: '/wt/x', tool, startedAt: 'y' } as never }); // a current host's entry
    const io = { live: () => [agent(100), agent(200)] };
    // 200 is the host's agent; 100 the old one in a terminal.
    expect(runsUnsafeFromBefore(id, s, new Set([200]), io)).toBe('outside');
    // Only the host's agent left: the guard drops out.
    expect(runsUnsafeFromBefore(id, s, new Set([200]), { live: () => [agent(200)] })).toBeNull();
    // Another session's agent doesn't count.
    expect(runsUnsafeFromBefore(id, s, new Set(), { live: () => [agent(300, '/elsewhere')] })).toBeNull();
  });

  it("an older host's entry decides on its own, and with an outside one too it's both", () => {
    saveHistory([s]);
    dbPtySessions.write({ [id]: { cwd: '/wt/x', tool, startedAt: 'y', ...{ unsafe: true } } as never });
    expect(runsUnsafeFromBefore(id, { ...s, launchedUnsafe: undefined }, new Set(), { live: () => [] })).toBe('old-host');
    expect(runsUnsafeFromBefore(id, s, new Set([200]), { live: () => [agent(100), agent(200)] })).toBe('both');
  });

  it("work web's check (the ci-routes and session-control-routes closure) reads the session and the host's pids at each call", () => {
    saveHistory([s]);
    let hostPids = new Set<number>();
    const check = legacyUnsafeCheck(() => hostPids, { live: () => [agent(100)], session: (x) => (x === id ? s : null) });
    expect(check(id)).toBe('outside');
    hostPids = new Set([100]); // the agent is the host's now
    expect(check(id)).toBeNull();
    expect(check('nope')).toBeNull();
  });
});

describe('clearLaunchedUnsafeWhenIdle', () => {
  it('leaves the flag while any agent of the session runs (in the host or not), and clears it once none does', () => {
    saveHistory([s]);
    expect(clearLaunchedUnsafeWhenIdle('api', 'feat/x', { live: () => [agent(100)] })).toBe(false);
    expect(loadHistory()[0].launchedUnsafe).toBe(true);
    expect(clearLaunchedUnsafeWhenIdle('api', 'feat/x', { live: () => [agent(100, '/elsewhere')] })).toBe(true);
    expect(loadHistory()[0]).not.toHaveProperty('launchedUnsafe');
    // Nothing to clear: nothing asked.
    expect(clearLaunchedUnsafeWhenIdle('api', 'feat/x', { live: () => [agent(100)] })).toBe(true);
    expect(clearLaunchedUnsafeWhenIdle('nope', 'x')).toBe(true);
  });
});
