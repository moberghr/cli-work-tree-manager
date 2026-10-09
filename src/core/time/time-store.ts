import { json, tx, withDb } from '../platform/db.js';
import type { TimeEntry } from './allocate.js';
import type { TimeDayRecord } from './time-view.js';

/**
 * Each day of the Time tab in state.db (`time_days`): what was found that
 * day and — kept apart, so a rebuild never overwrites it — what you changed
 * (`edited`) and whether it was a day off. The suggestion isn't stored: it
 * is worked out from the evidence and the settings as they are now
 * (time-view.ts), so a changed setting applies at once.
 */
export type { TimeDayRecord };

const isEntry = (v: unknown): v is TimeEntry =>
  !!v && typeof v === 'object' && typeof (v as TimeEntry).key === 'string' && typeof (v as TimeEntry).hours === 'number';

function isRecord(v: unknown): v is TimeDayRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const ev = r.evidence as Record<string, unknown> | undefined;
  return (
    typeof r.day === 'string' &&
    !!ev &&
    Array.isArray(ev.sessions) &&
    Array.isArray(ev.commits) &&
    Array.isArray(ev.jira) &&
    typeof r.titles === 'object' &&
    r.titles !== null &&
    typeof r.builtAt === 'string' &&
    (r.edited === null || (Array.isArray(r.edited) && r.edited.every(isEntry))) &&
    typeof r.dayOff === 'boolean'
  );
}

export function readDay(day: string): TimeDayRecord | null {
  return withDb((d) => {
    const row = d.prepare('SELECT data FROM time_days WHERE day = ?').get(day) as { data: string } | undefined;
    const v = row ? json.parse(row.data) : null;
    return isRecord(v) ? v : null;
  });
}

/** The days stored from `from` to `to` (inclusive, `YYYY-MM-DD`). */
export function readDays(from: string, to: string): TimeDayRecord[] {
  return withDb((d) =>
    (d.prepare('SELECT data FROM time_days WHERE day >= ? AND day <= ? ORDER BY day').all(from, to) as Array<{ data: string }>)
      .map((r) => json.parse(r.data))
      .filter(isRecord),
  );
}

/** A fresh build of the day: your edits and day off stay as they were. */
export function saveBuilt(built: Omit<TimeDayRecord, 'edited' | 'dayOff'>): TimeDayRecord {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM time_days WHERE day = ?').get(built.day) as { data: string } | undefined;
    const cur = row ? json.parse(row.data) : null;
    const next: TimeDayRecord = {
      ...built,
      edited: isRecord(cur) ? cur.edited : null,
      dayOff: isRecord(cur) ? cur.dayOff : false,
    };
    d.prepare('INSERT OR REPLACE INTO time_days (day, data) VALUES (?, ?)').run(built.day, JSON.stringify(next));
    return next;
  });
}

/** Change what you set on a day (your rows, a day off); a day never built gets a record with no evidence yet. */
export function updateDay(day: string, change: { edited?: TimeEntry[] | null; dayOff?: boolean }): TimeDayRecord {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM time_days WHERE day = ?').get(day) as { data: string } | undefined;
    const cur = row ? json.parse(row.data) : null;
    const base: TimeDayRecord = isRecord(cur)
      ? cur
      : { day, evidence: { sessions: [], commits: [], jira: [] }, titles: {}, builtAt: '', edited: null, dayOff: false };
    const next: TimeDayRecord = {
      ...base,
      ...(change.edited !== undefined ? { edited: change.edited } : {}),
      ...(change.dayOff !== undefined ? { dayOff: change.dayOff } : {}),
    };
    d.prepare('INSERT OR REPLACE INTO time_days (day, data) VALUES (?, ?)').run(day, JSON.stringify(next));
    return next;
  });
}
