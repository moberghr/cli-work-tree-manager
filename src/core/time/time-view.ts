import type { TimeDaysWire, TimeDaySummary, TimeDayWire, TimeEvidence, TimeSettingsWire } from '../api-types.js';
import {
  DEFAULT_TIME_SETTINGS,
  isWorkday,
  issueKeys,
  suggestDay,
  totalHours,
  type TicketActivity,
  type TimeEntry,
  type TimeSettings,
} from './allocate.js';
import type { PostedWorklog } from './tempo.js';

/**
 * The Time tab's days as it shows them (pure: the server, the demo and the
 * SPA share it): the suggestion worked out from a day's evidence and the
 * settings as they are now, and what will be posted — your rows when you
 * edited, else the suggestion.
 */

/** A day as stored (time-store.ts): its evidence, and what you set on it. */
export interface TimeDayRecord {
  day: string;
  evidence: TimeEvidence;
  titles: Record<string, string>;
  /** When its evidence was gathered ('' = never). */
  builtAt: string;
  /** Your rows (null: the suggestion stands). */
  edited: TimeEntry[] | null;
  dayOff: boolean;
  /** What work posted to Tempo, when, and the worklogs it made (tempo.ts). */
  posted?: { at: string; entries: TimeEntry[]; worklogs: PostedWorklog[] } | null;
}

export type TimeConfig = TimeSettings & { projects?: string[] };

/** The settings as config.json has them, over the defaults. */
export function timeSettings(cfg: (Partial<TimeSettings> & { projects?: string[] }) | undefined): TimeConfig {
  return { ...DEFAULT_TIME_SETTINGS, ...(cfg ?? {}) };
}

/** A session's ticket: its Jira key, else one in its branch, else in its name. */
export function sessionTicket(s: { jiraKey?: string; branch: string; title?: string }): string | null {
  return s.jiraKey ?? issueKeys(s.branch)[0] ?? (s.title ? (issueKeys(s.title)[0] ?? null) : null);
}

/** A local `YYYY-MM-DD`. */
export function localDay(ms = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The days from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00`); localDay(d.getTime()) <= to; d.setDate(d.getDate() + 1)) out.push(localDay(d.getTime()));
  return out;
}

/** What the evidence says each ticket got: Claude minutes, or touched (a commit, a move). */
export function activityOf(ev: TimeEvidence): TicketActivity[] {
  return [
    ...ev.sessions.filter((s) => s.key).map((s) => ({ key: s.key!, minutes: s.minutes })),
    ...ev.commits.flatMap((c) => c.keys.map((key) => ({ key, minutes: 0 }))),
    ...ev.jira.map((j) => ({ key: j.key, minutes: 0 })),
  ];
}

export const settingsWire = (s: TimeSettings): TimeSettingsWire => ({
  dayHours: s.dayHours,
  multiplier: s.multiplier,
  capHours: s.capHours,
  stepHours: s.stepHours,
  minHours: s.minHours,
  gapTicket: s.gapTicket,
  timeOffTicket: s.timeOffTicket,
});

const EMPTY: TimeEvidence = { sessions: [], commits: [], jira: [] };

/** A day as the tab shows it. */
export function dayWireOf(day: string, settings: TimeSettings, rec: TimeDayRecord | null): TimeDayWire {
  const workday = isWorkday(day, settings);
  const evidence = rec?.evidence ?? EMPTY;
  const dayOff = rec?.dayOff ?? false;
  const s = suggestDay(activityOf(evidence), settings, { dayOff });
  const edited = !!rec?.edited && !dayOff;
  const entries = edited ? rec!.edited! : s.entries;
  const posted = rec?.posted ?? null;
  const status: TimeDayWire['status'] = posted
    ? sameEntries(posted.entries, entries)
      ? 'posted'
      : 'changed'
    : dayOff
      ? 'off'
      : !workday
        ? 'not-workday'
        : edited
          ? 'edited'
          : rec?.builtAt
            ? 'draft'
            : 'empty';
  return {
    day,
    status,
    workday,
    dayOff,
    suggested: s.entries,
    entries,
    edited,
    unallocated: edited ? Math.max(0, Math.round((settings.dayHours - totalHours(entries)) * 100) / 100) : s.unallocated,
    total: totalHours(entries),
    evidence,
    titles: rec?.titles ?? {},
    builtAt: rec?.builtAt || null,
    settings: settingsWire(settings),
    posted: posted ? { at: posted.at, entries: posted.entries } : null,
  };
}

/** The same rows, in any order. Pure. */
export function sameEntries(a: readonly TimeEntry[], b: readonly TimeEntry[]): boolean {
  const k = (es: readonly TimeEntry[]) =>
    es
      .map((e) => `${e.key}=${e.hours}`)
      .sort()
      .join(',');
  return k(a) === k(b);
}

/** The days from `from` to `to`, newest first; a weekend or holiday shows only when something happened on it. */
export function daysWireOf(from: string, to: string, settings: TimeSettings, records: readonly TimeDayRecord[]): TimeDaysWire {
  const recs = new Map(records.map((r) => [r.day, r]));
  const days: TimeDaySummary[] = [];
  for (const day of daysBetween(from, to).reverse()) {
    const rec = recs.get(day) ?? null;
    const workday = isWorkday(day, settings);
    if (!workday && !(rec && (rec.evidence.sessions.length || rec.evidence.commits.length || rec.edited || rec.dayOff || rec.posted)))
      continue;
    const w = dayWireOf(day, settings, rec);
    days.push({ day, status: w.status, workday, total: w.total, tickets: w.entries.length });
  }
  return { days, settings: settingsWire(settings) };
}

const ENTRY_KEY = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/** Rows as sent: real issue keys, hours in steps of the setting, each key once. Null when they aren't. */
export function parseEntries(v: unknown, step: number): TimeEntry[] | null {
  if (!Array.isArray(v) || v.length > 50) return null;
  const out: TimeEntry[] = [];
  for (const e of v) {
    const key = (e as { key?: unknown })?.key;
    const hours = (e as { hours?: unknown })?.hours;
    if (typeof key !== 'string' || !ENTRY_KEY.test(key.trim()) || typeof hours !== 'number' || !(hours > 0) || hours > 24) return null;
    if (Math.abs(hours / step - Math.round(hours / step)) > 1e-9) return null;
    if (out.some((x) => x.key === key.trim())) return null;
    out.push({ key: key.trim(), hours });
  }
  return out;
}
