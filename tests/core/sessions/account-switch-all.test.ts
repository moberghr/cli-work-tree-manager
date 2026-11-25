import { describe, expect, it, vi } from 'vitest';
import {
  sessionsToSwitch,
  switchAllSessions,
  switchAllSummary,
  type SwitchAllSession,
} from '../../../src/core/sessions/account-switch-all.js';
import type { SwitchResult } from '../../../src/core/sessions/account-switch.js';

/** Every session to one account in one go (asked for: an account ran out, and each had to be switched by hand). */
const sessions: SwitchAllSession[] = [
  { target: 'api', branch: 'feat/a' },
  { target: 'api', branch: 'feat/b', account: 'admin' },
  { target: 'web', branch: 'feat/c', account: 'second' },
  { target: 'web', branch: 'old', archivedAt: '2026-11-01T00:00:00Z' },
];
const accountOf = (s: SwitchAllSession) => s.account ?? 'default';
const idOf = (s: SwitchAllSession) => `${s.target}:${s.branch}`;

describe('sessionsToSwitch', () => {
  it('every live session not on the account already; with a "from", only those on it; never an archived one', () => {
    expect(sessionsToSwitch(sessions, accountOf, 'admin').map(idOf)).toEqual(['api:feat/a', 'web:feat/c']);
    expect(sessionsToSwitch(sessions, accountOf, 'admin', 'default').map(idOf)).toEqual(['api:feat/a']);
    expect(sessionsToSwitch(sessions, accountOf, 'default').map(idOf)).toEqual(['api:feat/b', 'web:feat/c']);
    expect(sessionsToSwitch(sessions, accountOf, 'admin', 'nobody')).toEqual([]);
  });
});

describe('switchAllSessions', () => {
  it('switches each in turn through the one-session switch, and says how each went', async () => {
    const order: string[] = [];
    const switchAccount = vi.fn(async (id: string, to: string): Promise<SwitchResult> => {
      order.push(`${id}→${to}`);
      return id === 'api:feat/a' ? { ok: true, outcome: 'switched', moved: 3 } : { ok: true, outcome: 'switched', interrupted: true };
    });
    const rows = await switchAllSessions({ sessions: () => sessions, accountOf, idOf, switchAccount }, 'admin');
    expect(order).toEqual(['api:feat/a→admin', 'web:feat/c→admin']);
    expect(rows).toEqual([
      { id: 'api:feat/a', label: 'api · feat/a', outcome: 'switched' },
      { id: 'web:feat/c', label: 'web · feat/c', outcome: 'switched', interrupted: true },
    ]);
  });

  it('one that is refused, or throws, is said and the rest still go', async () => {
    const switchAccount = vi.fn(async (id: string): Promise<SwitchResult> => {
      if (id === 'api:feat/a') return { ok: false, status: 409, error: 'it is being archived' };
      if (id === 'web:feat/c') throw new Error('host gone');
      return { ok: true, outcome: 'recorded' };
    });
    const rows = await switchAllSessions({ sessions: () => sessions, accountOf, idOf, switchAccount }, 'third');
    expect(rows).toEqual([
      { id: 'api:feat/a', label: 'api · feat/a', error: 'it is being archived' },
      { id: 'api:feat/b', label: 'api · feat/b', outcome: 'recorded' },
      { id: 'web:feat/c', label: 'web · feat/c', error: 'host gone' },
    ]);
  });
});

describe('switchAllSummary', () => {
  it('counts what moved by how, and what was refused; none to move says so', () => {
    expect(
      switchAllSummary(
        [
          { id: '1', label: 'a', outcome: 'switched' },
          { id: '2', label: 'b', outcome: 'switched' },
          { id: '3', label: 'c', outcome: 'switched', interrupted: true },
          { id: '4', label: 'd', outcome: 'recorded' },
          { id: '5', label: 'e', error: 'no' },
        ],
        'admin',
      ),
    ).toBe('4 sessions moved to admin: 3 restarted on it, 1 on its next start; 1 refused. 1 was mid-turn: tell it to continue');
    expect(
      switchAllSummary(
        [
          { id: '1', label: 'a', outcome: 'switched', interrupted: true },
          { id: '2', label: 'b', outcome: 'switched', interrupted: true },
        ],
        'admin',
      ),
    ).toBe('2 sessions moved to admin: 2 restarted on it. 2 were mid-turn: tell them to continue');
    expect(switchAllSummary([{ id: '1', label: 'a', outcome: 'recorded' }], 'admin')).toBe('1 session moved to admin: 1 on its next start');
    expect(switchAllSummary([], 'admin')).toBe('No session to move: every one is on admin already.');
  });
});
