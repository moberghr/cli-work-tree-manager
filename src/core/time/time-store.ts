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

const isWorklog = (v: unknown): boolean => {
  const w = v as Record<string, unknown> | null;
  return (
    !!w &&
    typeof w === 'object' &&
    typeof w.tempoWorklogId === 'number' &&
    typeof w.key === 'string' &&
    typeof w.issueId === 'number' &&
    typeof w.seconds === 'number' &&
    typeof w.startTime === 'string'
  );
};

/** What was posted to Tempo, as stored: absent, or whole (its rows and the worklogs work made). */
const isPosted = (v: unknown): boolean => {
  if (v === undefined || v === null) return true;
  const p = v as Record<string, unknown>;
  return (
    typeof p === 'object' &&
    typeof p.at === 'string' &&
    Array.isArray(p.entries) &&
    p.entries.every(isEntry) &&
    Array.isArray(p.worklogs) &&
    p.worklogs.every(isWorklog)
  );
};

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
    typeof r.dayOff === 'boolean' &&
    isPosted(r.posted)
  );
}

/** Jira issue ids by key (Tempo wants the id), kept in state.db's meta: an issue's id never changes. */
export function readIssueIds(): Record<string, number> {
  return withDb((d) => {
    const row = d.prepare("SELECT value FROM meta WHERE key = 'time:issue-ids'").get() as { value: string } | undefined;
    const v = row ? json.parse(row.value) : null;
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, number] => typeof e[1] === 'number'));
  });
}

export function rememberIssueId(key: string, id: number): void {
  tx((d) => {
    const row = d.prepare("SELECT value FROM meta WHERE key = 'time:issue-ids'").get() as { value: string } | undefined;
    const v = row ? json.parse(row.value) : null;
    const ids = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    ids[key] = id;
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('time:issue-ids', ?)").run(JSON.stringify(ids));
  });
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

/** A fresh build of the day: your edits, day off and what was posted to Tempo stay as they were. */
export function saveBuilt(built: Omit<TimeDayRecord, 'edited' | 'dayOff' | 'posted'>): TimeDayRecord {
  return tx((d) => {
    const row = d.prepare('SELECT data FROM time_days WHERE day = ?').get(built.day) as { data: string } | undefined;
    const cur = row ? json.parse(row.data) : null;
    const next: TimeDayRecord = {
      ...built,
      edited: isRecord(cur) ? cur.edited : null,
      dayOff: isRecord(cur) ? cur.dayOff : false,
      // The worklogs work made: without them a later post can't tell them from your own, and would post beside them.
      ...(isRecord(cur) && cur.posted ? { posted: cur.posted } : {}),
    };
    d.prepare('INSERT OR REPLACE INTO time_days (day, data) VALUES (?, ?)').run(built.day, JSON.stringify(next));
    return next;
  });
}

/** Change what you set on a day (your rows, a day off); a day never built gets a record with no evidence yet. */
export function updateDay(
  day: string,
  change: { edited?: TimeEntry[] | null; dayOff?: boolean; posted?: TimeDayRecord['posted'] },
): TimeDayRecord {
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
      ...(change.posted !== undefined ? { posted: change.posted } : {}),
    };
    d.prepare('INSERT OR REPLACE INTO time_days (day, data) VALUES (?, ?)').run(day, JSON.stringify(next));
    return next;
  });
}
