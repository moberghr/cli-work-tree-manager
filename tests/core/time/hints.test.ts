import { describe, expect, it } from 'vitest';
import { hintKey, placeholderKeys, type TicketHint } from '../../../src/core/time/hints.js';
import { DEFAULT_TIME_SETTINGS } from '../../../src/core/time/allocate.js';
import { buildDay, dayWire, daysWire, type TimeDeps } from '../../../src/core/time/time-days.js';
import { readDay } from '../../../src/core/time/time-store.js';
import { describeTimeDay, type TimeConfig } from '../../../src/core/time/time-view.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

// Each test file has its own HOME (tests/setup): state.db here is a throwaway.
const HINTS: Record<string, TicketHint> = {
  'SSD-2222': { summary: 'Rapyd reconciliation (Valitor analysis)', matches: ['valitor', 'rapyd reconciliation'] },
  'SD-9001': { summary: 'Beta environment fixes', matches: ['fix-beta', 'beta deploy'], placeholder: true },
};
const S: TimeConfig = { ...DEFAULT_TIME_SETTINGS, gapTicket: 'SD-434', timeOffTicket: 'INT-1', hints: HINTS };
const session = (branch: string, over: Partial<WorktreeSession> = {}) =>
  ({ target: 'api', branch, isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', ...over }) as WorktreeSession;

describe('ticket hints (hints.ts)', () => {
  it('the first hint whose words appear, case aside; none: null', () => {
    expect(hintKey(['api · tmp-Valitor-analysis'], HINTS)).toBe('SSD-2222');
    expect(hintKey(['Fix-Beta-deploy'], HINTS)).toBe('SD-9001');
    expect(hintKey(['something else', undefined], HINTS)).toBeNull();
    expect(hintKey(['valitor'], undefined)).toBeNull();
  });

  it('placeholders among the rows', () => {
    expect(placeholderKeys(['SD-9001', 'SSD-2222', 'SD-1'], HINTS)).toEqual(['SD-9001']);
  });
});

describe('a day built with what the timesheet tool had', () => {
  const deps = (over: Partial<TimeDeps> = {}): TimeDeps => ({
    sessions: () => [session('tmp-valitor-analysis'), session('feat/SD-1-x')],
    minutesOn: async () => 30,
    commits: async () => [{ repo: 'api', sha: 'c1', subject: 'fix-beta: the deploy script' }],
    jiraMoved: async () => [],
    titles: async (keys) =>
      Object.fromEntries(keys.filter((k) => k !== 'SD-9001').map((k) => [k, { title: `Title of ${k}`, done: k === 'SD-1' }])),
    settings: () => S,
    meetings: async () => [
      { subject: 'SSD-2471 sync', start: '10:00', end: '10:30', minutes: 30 },
      { subject: 'Valitor analysis call', start: '11:00', end: '12:00', minutes: 60 },
      { subject: 'Daily', start: '09:30', end: '09:45', minutes: 15 },
    ],
    chats: async () => [
      // Someone named SD-1 in the chat (only the keys are read from others' messages); UTF-8 isn't an issue.
      { id: 'c1', chat: 'Payments', messages: 2, sample: ['looking at it'], mentions: ['UTF-8', 'SD-1'] },
      { id: 'c2', chat: 'a one-on-one chat', messages: 1, sample: ['lunch?'] },
    ],
    ...over,
  });

  it('hints place sessions, commits and meetings; a subject names its ticket; a chat takes a key named in it', async () => {
    const rec = await buildDay('2026-09-14', deps());
    expect(rec.evidence.sessions.map((s) => s.key).sort()).toEqual(['SD-1', 'SSD-2222']);
    expect(rec.evidence.commits[0].keys).toEqual(['SD-9001']);
    expect(rec.evidence.meetings!.map((m) => m.key)).toEqual(['SSD-2471', 'SSD-2222', undefined]);
    expect(rec.evidence.chats!.map((c) => c.key)).toEqual(['SD-1', undefined]);
    // None of these was a guess.
    expect([...rec.evidence.sessions, ...rec.evidence.meetings!, ...rec.evidence.chats!].some((x) => x.guessed)).toBe(false);
  });

  it('a ticket Jira has as done is said on its row; a placeholder says to create it first, with the hint as its title', async () => {
    await buildDay('2026-09-15', deps());
    expect(readDay('2026-09-15')?.resolved).toEqual(['SD-1']);
    const w = dayWire('2026-09-15', S);
    expect(w.resolved).toEqual(['SD-1']);
    expect(w.placeholders).toEqual(['SD-9001']);
    expect(w.titles['SD-9001']).toBe('Beta environment fixes');
    expect(describeTimeDay(w)).toContain('Done in Jira already: SD-1.');
    expect(describeTimeDay(w)).toContain('Placeholders, to create in Jira before posting: SD-9001.');
    // Jira can't be asked this time: what it said before stands.
    await buildDay('2026-09-15', deps({ titles: async () => Promise.reject(new Error('acli')) }));
    expect(readDay('2026-09-15')?.resolved).toEqual(['SD-1']);
  });

  it('a weekend day with only Jira moves or chats is listed (its tickets get time)', async () => {
    await buildDay(
      '2026-09-12', // a Saturday
      deps({
        sessions: () => [],
        commits: async () => [],
        meetings: async () => [],
        chats: async () => [],
        jiraMoved: async () => [{ key: 'SD-1', summary: 'One', what: 'moved (now Done)' }],
      }),
    );
    expect(daysWire('2026-09-12', '2026-09-12', S).days.map((d) => d.day)).toEqual(['2026-09-12']);
  });

  it('a vacation day (time.vacation) is a day off on the time-off ticket, whatever was ticked or worked', async () => {
    await buildDay('2026-07-17', deps());
    const w = dayWire('2026-07-17', { ...S, vacation: ['2026-07-17'] });
    expect(w).toMatchObject({ dayOff: true, vacation: true, status: 'off', entries: [{ key: 'INT-1', hours: 7.5 }] });
    expect(dayWire('2026-07-17', S)).toMatchObject({ dayOff: false, vacation: false });
  });

  it('meetings and chats that name their ticket are not given to the AI step', async () => {
    const asked: string[] = [];
    await buildDay(
      '2026-09-16',
      deps({
        classify: async (prompt) => {
          asked.push(prompt);
          return '{"place":[]}';
        },
      }),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Daily');
    expect(asked[0]).toContain('lunch?');
    expect(asked[0]).not.toContain('SSD-2471 sync');
    expect(asked[0]).not.toContain('Payments');
    // The hints are candidates; a placeholder (not in Jira) by its summary.
    expect(asked[0]).toContain('- SD-9001: Beta environment fixes');
  });
});
