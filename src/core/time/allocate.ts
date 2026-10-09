/**
 * A day's suggested hours, from what was worked on (pure; the SPA and the
 * demo use it too). The timesheet tool's rules, as settings: a day of
 * `dayHours`, measured Claude time scaled by `multiplier` (an hour of Claude
 * at work stands for more of yours: reading, testing, talking), all of it
 * capped at `capHours`, in `stepHours` steps with at least `minHours` a
 * ticket, and what's left to the `gapTicket` (meetings, reviews, the rest).
 * A ticket touched with no measured time (a commit, an issue moved) gets the
 * minimum. Unlike the tool, it never goes over the day — too many tickets
 * trim the biggest first, then drop the smallest — and nothing is taken out
 * of one entry alone.
 */

export interface TimeSettings {
  /** A workday's hours. */
  dayHours: number;
  /** Measured Claude minutes × this = your hours on it. */
  multiplier: number;
  /** At most this much of a day to tickets (the gap ticket keeps the rest). */
  capHours: number;
  stepHours: number;
  /** A ticket that gets time gets at least this. */
  minHours: number;
  /** Gets what's left of the day (null: left unallocated). */
  gapTicket: string | null;
  /** A day off is booked to it (null: a day off books nothing). */
  timeOffTicket: string | null;
  /** Days that aren't workdays besides weekends (`YYYY-MM-DD`). */
  holidays: string[];
}

export const DEFAULT_TIME_SETTINGS: TimeSettings = {
  dayHours: 7.5,
  multiplier: 5,
  capHours: 7,
  stepHours: 0.25,
  minHours: 0.5,
  gapTicket: null,
  timeOffTicket: null,
  holidays: [],
};

/** What a ticket got that day: measured minutes, or only touched (commits, a transition). */
export interface TicketActivity {
  key: string;
  minutes: number;
}

export interface TimeEntry {
  key: string;
  hours: number;
}

export interface DaySuggestion {
  entries: TimeEntry[];
  /** Hours of the day no ticket got (no gap ticket set). */
  unallocated: number;
}

/** A day's suggestion. `dayOff`: all of it to the time-off ticket. */
export function suggestDay(activity: readonly TicketActivity[], s: TimeSettings, opts: { dayOff?: boolean } = {}): DaySuggestion {
  // Whole steps, so sums are exact.
  const units = (h: number) => Math.round(h / s.stepHours);
  const day = units(s.dayHours);
  const hours = (u: number) => Math.round(u * s.stepHours * 100) / 100;
  if (opts.dayOff)
    return s.timeOffTicket
      ? { entries: [{ key: s.timeOffTicket, hours: s.dayHours }], unallocated: 0 }
      : { entries: [], unallocated: s.dayHours };

  // One row per ticket; the gap ticket's own time goes into what it gets at the end.
  const minutes = new Map<string, number>();
  for (const a of activity) {
    if (!a.key || a.key === s.gapTicket) continue;
    minutes.set(a.key, (minutes.get(a.key) ?? 0) + Math.max(0, a.minutes));
  }
  const min = Math.max(1, units(s.minHours));
  // Room for tickets: the cap, and the day less the gap ticket's minimum when there is one.
  const room = Math.max(0, Math.min(units(s.capHours), day - (s.gapTicket ? min : 0)));
  const raw = [...minutes].map(([key, m]) => ({ key, raw: m > 0 ? (m / 60) * s.multiplier : s.minHours }));
  const total = raw.reduce((n, r) => n + r.raw, 0);
  const scale = total > room * s.stepHours && total > 0 ? (room * s.stepHours) / total : 1;
  let rows = raw
    .map((r) => {
      const scaled = r.raw * scale;
      const u = units(scaled);
      // Under the minimum: the minimum when it's at least a step's worth, else nothing.
      return { key: r.key, raw: scaled, u: u >= min ? u : scaled >= s.stepHours ? min : 0 };
    })
    .filter((r) => r.u > 0);
  // Rounding up to minimums can overshoot the room: trim the biggest a step at a time, then drop the smallest.
  let used = rows.reduce((n, r) => n + r.u, 0);
  while (used > room && rows.length) {
    const big = rows.filter((r) => r.u > min).sort((a, b) => b.u - a.u || a.key.localeCompare(b.key))[0];
    if (big) big.u--;
    else rows = rows.sort((a, b) => a.raw - b.raw).slice(1);
    used = rows.reduce((n, r) => n + r.u, 0);
  }
  const entries = rows.sort((a, b) => b.u - a.u || a.key.localeCompare(b.key)).map((r) => ({ key: r.key, hours: hours(r.u) }));
  const left = day - used;
  if (s.gapTicket && left > 0) return { entries: [...entries, { key: s.gapTicket, hours: hours(left) }], unallocated: 0 };
  return { entries, unallocated: hours(Math.max(0, left)) };
}

/** Sum of a day's entries, in hours (to two decimals). */
export function totalHours(entries: readonly TimeEntry[]): number {
  return Math.round(entries.reduce((n, e) => n + e.hours, 0) * 100) / 100;
}

/** Monday to Friday, and not a holiday. */
export function isWorkday(day: string, s: Pick<TimeSettings, 'holidays'>): boolean {
  const d = new Date(`${day}T12:00:00`);
  const wd = d.getDay();
  return wd !== 0 && wd !== 6 && !s.holidays.includes(day);
}

/** A Jira issue key, as found in a branch, a commit subject or a title. */
export const ISSUE_KEY = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/** The issue keys in a text, only of the given projects when any are given (`UTF-8` isn't an issue). */
export function issueKeys(text: string, projects?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(ISSUE_KEY)) {
    const key = m[1];
    if (projects && projects.size && !projects.has(key.split('-')[0])) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}
