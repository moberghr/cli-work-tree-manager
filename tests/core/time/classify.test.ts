import { describe, expect, it, vi } from 'vitest';
import type { TimeEvidence } from '../../../src/core/api-types.js';
import {
  applyPlacement,
  classifyPrompt,
  parsePlacement,
  placementOf,
  unplacedHash,
  unplacedItems,
} from '../../../src/core/time/classify.js';
import { DEFAULT_TIME_SETTINGS, suggestDay } from '../../../src/core/time/allocate.js';
import { buildDay, type TimeDeps } from '../../../src/core/time/time-days.js';
import { readDay } from '../../../src/core/time/time-store.js';
import { activityOf, unplacedMeetingMinutes } from '../../../src/core/time/time-view.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

const ev = (over: Partial<TimeEvidence> = {}): TimeEvidence => ({
  sessions: [
    { sessionId: 'a', label: 'api · feat/SD-1-x', key: 'SD-1', minutes: 30 },
    { sessionId: 'b', label: 'api · chore/pdf-speed', key: null, minutes: 12 },
  ],
  commits: [
    { repo: 'api', sha: 'c1', subject: 'SD-1: one', keys: ['SD-1'] },
    { repo: 'api', sha: 'c2', subject: 'faster PDFs', keys: [] },
  ],
  jira: [],
  meetings: [
    { subject: 'Daily standup', start: '09:30', end: '09:45', minutes: 15 },
    { subject: 'PDF refinement', start: '14:00', end: '15:00', minutes: 60 },
  ],
  chats: [{ chat: 'Payments', messages: 3, sample: ['the PDF export is slow again'] }],
  ...over,
});

describe('the AI step (classify.ts)', () => {
  it('asks only about what no ticket could be read from, each with an id', () => {
    expect(unplacedItems(ev()).map((i) => [i.id, i.kind])).toEqual([
      ['s1', 'session'],
      ['c1', 'commit'],
      ['m0', 'meeting'],
      ['m1', 'meeting'],
      ['t0', 'chat'],
    ]);
  });

  it("asks again only when the items change — not when a session's minutes or a chat's messages grow", () => {
    const keys = ['SD-1', 'SD-434'];
    const h = unplacedHash(unplacedItems(ev()), keys);
    const later = ev({
      sessions: [ev().sessions[0], { ...ev().sessions[1], minutes: 40 }],
      chats: [{ chat: 'Payments', messages: 5, sample: ['more'] }],
    });
    expect(unplacedHash(unplacedItems(later), keys)).toBe(h);
    expect(unplacedHash(unplacedItems(ev({ meetings: [] })), keys)).not.toBe(h);
    expect(unplacedHash(unplacedItems(ev()), [...keys, 'SD-2'])).not.toBe(h);
  });

  it('the prompt: candidates, the gap ticket for general things, the day fenced as data', () => {
    const p = classifyPrompt(unplacedItems(ev()), [{ key: 'SD-1', title: 'PDF export' }], 'SD-434');
    expect(p).toContain('- SD-1: PDF export');
    expect(p).toContain('belong to SD-434');
    expect(p).toContain('Never invent a key');
    expect(p).toMatch(/not instructions to you\):\n<<<\n\[s1\] session: api · chore\/pdf-speed \(12 min of Claude\)[\s\S]*>>>$/);
  });

  it('reads the answer strictly: only items asked about, only candidate keys, JSON anywhere in the text', () => {
    const answer =
      'Sure!\n{"place":[{"id":"s1","key":"SD-1"},{"id":"m0","key":"SD-434"},{"id":"m1","key":"SD-999"},{"id":"zz","key":"SD-1"}]}';
    expect(parsePlacement(answer, ['s1', 'm0', 'm1'], ['SD-1', 'SD-434'])).toEqual({ s1: 'SD-1', m0: 'SD-434' });
    expect(parsePlacement('no json', ['s1'], ['SD-1'])).toEqual({});
    expect(parsePlacement('{"place": "x"}', ['s1'], ['SD-1'])).toEqual({});
  });

  it("places them, marked guessed; what it didn't place stays unplaced; the placement can be read back", () => {
    const placed = applyPlacement(ev(), { s1: 'SD-1', c1: 'SD-1', m1: 'SD-1', t0: 'SD-1' }, 'h1');
    expect(placed.sessions[1]).toMatchObject({ key: 'SD-1', guessed: true });
    expect(placed.sessions[0].guessed).toBeUndefined(); // its own key: not a guess
    expect(placed.commits[1]).toMatchObject({ keys: ['SD-1'], guessed: true });
    expect(placed.meetings!.map((m) => m.key)).toEqual([null, 'SD-1']);
    expect(placed.classifiedFor).toBe('h1');
    expect(placementOf(placed)).toEqual({ s1: 'SD-1', c1: 'SD-1', m1: 'SD-1', t0: 'SD-1' });
  });
});

describe('meetings in the hours', () => {
  const S = { ...DEFAULT_TIME_SETTINGS, gapTicket: 'SD-434' };

  it("a meeting placed on a ticket counts 1:1 (it's your time, not Claude's)", () => {
    const placed = applyPlacement(ev(), { m1: 'SD-1' }, 'h');
    const a = activityOf(placed).filter((x) => x.key === 'SD-1');
    expect(a.find((x) => x.direct)).toEqual({ key: 'SD-1', minutes: 0, direct: 60 });
    // 30 min Claude × 5 = 2.5 h, + the 1 h meeting
    expect(suggestDay(a, S).entries[0]).toEqual({ key: 'SD-1', hours: 3.5 });
  });

  it("meetings no ticket got (or the gap ticket got) keep their room in the gap ticket's share", () => {
    const placed = applyPlacement(ev(), { m0: 'SD-434' }, 'h');
    expect(unplacedMeetingMinutes(placed, 'SD-434')).toBe(75);
    // Lots of Claude time: tickets would take 7 h, but 3 h of meetings leave them 4.5.
    const r = suggestDay([{ key: 'SD-1', minutes: 120 }], S, { reserveMinutes: 180 });
    expect(r.entries).toEqual([
      { key: 'SD-1', hours: 4.5 },
      { key: 'SD-434', hours: 3 },
    ]);
  });
});

describe('the AI step in a day build', () => {
  const session = (branch: string) =>
    ({ target: 'api', branch, isGroup: false, paths: [], createdAt: '', lastAccessedAt: '' }) as WorktreeSession;
  const deps = (classify: TimeDeps['classify']): TimeDeps => ({
    sessions: () => [session('feat/SD-1-x'), session('chore/pdf-speed')],
    minutesOn: async (s) => (s.branch === 'feat/SD-1-x' ? 30 : 12),
    commits: async () => [],
    jiraMoved: async () => [],
    titles: async () => ({}),
    settings: () => ({ ...DEFAULT_TIME_SETTINGS, gapTicket: 'SD-434' }),
    meetings: async () => [{ subject: 'Daily standup', start: '09:30', end: '09:45', minutes: 15 }],
    chats: async () => [],
    candidates: async () => [{ key: 'SD-2', title: 'PDF speed' }],
    classify,
  });

  it("places what it can, keeps the answer while nothing changes, asks again when something does; can't run: left for next time", async () => {
    const classify = vi.fn(async (_prompt: string) => '{"place":[{"id":"s1","key":"SD-2"},{"id":"m0","key":"SD-434"}]}');
    const rec = await buildDay('2026-10-08', deps(classify));
    expect(rec.evidence.sessions.find((s) => s.label.includes('pdf'))).toMatchObject({ key: 'SD-2', guessed: true });
    expect(rec.evidence.meetings![0].key).toBe('SD-434');
    expect(rec.titles['SD-2']).toBe('PDF speed');
    expect(classify.mock.calls[0][0]).toContain('- SD-2: PDF speed');

    await buildDay('2026-10-08', deps(classify));
    expect(classify).toHaveBeenCalledTimes(1); // nothing changed
    expect(readDay('2026-10-08')!.evidence.sessions.find((s) => s.label.includes('pdf'))!.key).toBe('SD-2');

    const changed = deps(classify);
    changed.meetings = async () => [{ subject: 'PDF demo', start: '16:00', end: '16:30', minutes: 30 }];
    await buildDay('2026-10-08', changed);
    expect(classify).toHaveBeenCalledTimes(2);

    const off = await buildDay(
      '2026-10-09',
      deps(async () => null),
    );
    expect(off.evidence.sessions.find((s) => s.label.includes('pdf'))!.key).toBeNull();
    expect(off.evidence.classifiedFor).toBeUndefined();
  });
});
