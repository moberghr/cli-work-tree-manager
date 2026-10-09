import type { TimeDaysWire, TimeDayWire, TimeEvidence, TimePostWire } from '../../core/api-types.js';
import { DEFAULT_TIME_SETTINGS, isWorkday, type TimeEntry } from '../../core/time/allocate.js';
import { daysBetween, dayWireOf, daysWireOf, localDay, type TimeConfig, type TimeDayRecord } from '../../core/time/time-view.js';

/**
 * The demo's Time tab: two weeks of made-up evidence (sessions with Claude
 * minutes, commits, an issue moved), through the real suggestion and view
 * (time-view.ts). Edits and days off are kept in memory.
 */

const SETTINGS: TimeConfig = { ...DEFAULT_TIME_SETTINGS, gapTicket: 'OPS-1', timeOffTicket: 'HR-1' };

const TITLES: Record<string, string> = {
  'PAY-12': 'Export invoices as CSV',
  'PAY-15': 'Invoice PDF',
  'SHOP-7': 'Checkout in two steps',
  'WEB-3': 'Price and brand filters in search',
  'WEB-9': 'Login redirect loop',
  'OPS-1': 'Meetings, reviews and support',
  'HR-1': 'Time off',
};

const WORK = [
  { id: 'demo-api-feat-invoice-export', label: 'api · feat/invoice-export', key: 'PAY-12' },
  { id: 'demo-api-feat-invoice-pdf', label: 'api · feat/invoice-pdf', key: 'PAY-15' },
  { id: 'demo-shop-feat-checkout-v2', label: 'shop · feat/checkout-v2', key: 'SHOP-7' },
  { id: 'demo-web-feat-search-filters', label: 'web · feat/search-filters', key: 'WEB-3' },
  { id: 'demo-web-fix-login-redirect', label: 'web · fix/login-redirect', key: 'WEB-9' },
];

/** A day's evidence, the same every time for the same day (seeded by its number). */
function evidenceFor(n: number): TimeEvidence {
  const pick = [WORK[n % WORK.length], WORK[(n + 2) % WORK.length]];
  return {
    sessions: [
      { sessionId: pick[0].id, label: pick[0].label, key: pick[0].key, minutes: 25 + ((n * 7) % 30) },
      { sessionId: pick[1].id, label: pick[1].label, key: pick[1].key, minutes: 8 + ((n * 5) % 15) },
      ...(n % 3 === 0 ? [{ sessionId: 'demo-api-chore-deps-update', label: 'api · chore/deps-update', key: null, minutes: 12 }] : []),
    ],
    commits: [
      {
        repo: pick[0].id.split('-')[1],
        sha: `c0ffee${n}0`,
        subject: `${pick[0].key}: ${TITLES[pick[0].key].toLowerCase()}, part ${(n % 4) + 1}`,
        keys: [pick[0].key],
      },
    ],
    jira: n % 4 === 1 ? [{ key: 'WEB-9', summary: TITLES['WEB-9'], what: 'moved (now In review)' }] : [],
  };
}

export function createDemoTime(now: () => number) {
  const edits = new Map<string, { edited?: TimeEntry[] | null; dayOff?: boolean; posted?: TimeDayRecord['posted'] }>();
  const record = (day: string): TimeDayRecord | null => {
    const today = localDay(now());
    if (day > today) return null;
    const all = daysBetween(localDay(now() - 13 * 24 * 3600_000), today);
    const n = all.indexOf(day);
    const e = edits.get(day) ?? {};
    // Two weeks of work days; before that, nothing gathered.
    if (n < 0 && !e.edited && !e.dayOff) return null;
    return {
      day,
      evidence: n >= 0 && isWorkday(day, SETTINGS) ? evidenceFor(n) : { sessions: [], commits: [], jira: [] },
      titles: TITLES,
      builtAt: new Date(now()).toISOString(),
      edited: e.edited ?? null,
      dayOff: e.dayOff ?? false,
      posted: e.posted ?? null,
    };
  };
  return {
    days: (from: string, to: string): TimeDaysWire =>
      daysWireOf(
        from,
        to,
        SETTINGS,
        daysBetween(from, to)
          .map(record)
          .filter((r): r is TimeDayRecord => !!r),
      ),
    day: (day: string): TimeDayWire => ({ ...dayWireOf(day, SETTINGS, record(day)), posting: { ready: true, why: null } }),
    update: (day: string, change: { edited?: TimeEntry[] | null; dayOff?: boolean }): TimeDayWire => {
      edits.set(day, { ...(edits.get(day) ?? {}), ...change });
      return { ...dayWireOf(day, SETTINGS, record(day)), posting: { ready: true, why: null } };
    },
    /** "Posting": what the day shows is now what Tempo has (nothing leaves the demo). */
    post: (day: string): TimePostWire => {
      const w = dayWireOf(day, SETTINGS, record(day));
      const before = record(day)?.posted?.entries ?? [];
      const kept = w.entries.filter((e) => before.some((b) => b.key === e.key && b.hours === e.hours)).length;
      edits.set(day, { ...(edits.get(day) ?? {}), posted: { at: new Date(now()).toISOString(), entries: w.entries, worklogs: [] } });
      return {
        posted: w.entries.length - kept,
        removed: before.length - kept,
        kept,
        coveredByHand: 0,
        otherByHand: 0,
        failed: [],
        day: { ...dayWireOf(day, SETTINGS, record(day)), posting: { ready: true, why: null } },
      };
    },
    settings: SETTINGS,
  };
}
