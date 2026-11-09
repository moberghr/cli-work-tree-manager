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
  /** Your days off (`YYYY-MM-DD`): booked whole to the time-off ticket, whatever else happened (the timesheet tool's VACATION_DAYS). */
  vacation: string[];
  /**
   * Hours as measured (the timesheet tool's `build --effort`): Claude minutes 1:1 in steps, no multiplier and no
   * minimum beyond a step, a ticket only touched gets no row; the gap ticket takes the rest of the day.
   */
  effort: boolean;
  /** Projects whose tickets are service desk (keep `minHours`); any other project's ticket is a task. */
  deskProjects: string[];
  /** A task's row on a day is at least this (null: tasks get `minHours` like any ticket). */
  taskMinHours: number | null;
  /** A task's measured hours × (1 + this × (story points − 1)) before the day is shared out (0: points don't count). */
  pointsWeight: number;
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
  vacation: [],
  effort: false,
  deskProjects: [],
  taskMinHours: null,
  pointsWeight: 0.25,
};

/** A ticket that isn't service desk, the gap ticket or time off: a task (its own minimum, its story points count). */
export function isTask(key: string, s: Pick<TimeSettings, 'deskProjects' | 'gapTicket' | 'timeOffTicket'>): boolean {
  return key !== s.gapTicket && key !== s.timeOffTicket && !s.deskProjects.includes(key.split('-')[0]);
}

/** What a ticket got that day: measured Claude minutes (× multiplier), your own minutes on it (a meeting: 1:1), or only touched (0). */
export interface TicketActivity {
  key: string;
  minutes: number;
  direct?: number;
}

export interface TimeEntry {
  key: string;
  hours: number;
}

export interface DaySuggestion {
  entries: TimeEntry[];
  /** Hours of the day no ticket got (no gap ticket set). */
  unallocated: number;
  /** How each row got its hours, in words, by key: "51 min of Claude × 5 = 4.25 h". */
  why: Record<string, string>;
}

/** "4.25 h". */
const h2 = (h: number) => `${Math.round(h * 100) / 100} h`;

/**
 * A day's suggestion. `dayOff`: all of it to the time-off ticket.
 * `reserveMinutes`: meetings no ticket got — kept for the gap ticket, so
 * the tickets' share shrinks to leave them room.
 */
export function suggestDay(
  activity: readonly TicketActivity[],
  s: TimeSettings,
  opts: { dayOff?: boolean; reserveMinutes?: number; points?: Record<string, number> } = {},
): DaySuggestion {
  // Whole steps, so sums are exact.
  const units = (h: number) => Math.round(h / s.stepHours);
  const day = units(s.dayHours);
  const hours = (u: number) => Math.round(u * s.stepHours * 100) / 100;
  if (opts.dayOff)
    return s.timeOffTicket
      ? { entries: [{ key: s.timeOffTicket, hours: s.dayHours }], unallocated: 0, why: { [s.timeOffTicket]: 'a day off: the whole day' } }
      : { entries: [], unallocated: s.dayHours, why: {} };

  // One row per ticket; the gap ticket's own time goes into what it gets at the end.
  const minutes = new Map<string, { claude: number; direct: number }>();
  for (const a of activity) {
    if (!a.key || a.key === s.gapTicket) continue;
    const m = minutes.get(a.key) ?? { claude: 0, direct: 0 };
    m.claude += Math.max(0, a.minutes);
    m.direct += Math.max(0, a.direct ?? 0);
    minutes.set(a.key, m);
  }
  const min = s.effort ? 1 : Math.max(1, units(s.minHours));
  // A task's own minimum (as measured, none beyond a step).
  const task = (key: string) => !s.effort && s.taskMinHours !== null && isTask(key, s);
  const minFor = (key: string) => (task(key) ? Math.max(min, units(s.taskMinHours!)) : min);
  // Story points weigh a task's share: × (1 + weight × (points − 1)); unknown points, a desk ticket: × 1.
  const factorFor = (key: string) => {
    const p = opts.points?.[key];
    return !s.effort && p !== undefined && p > 0 && isTask(key, s) ? Math.max(0, 1 + s.pointsWeight * (p - 1)) : 1;
  };
  const multiplier = s.effort ? 1 : s.multiplier;
  // Room for tickets: the cap, and the day less what the gap ticket keeps (its minimum, or the meetings it has).
  const reserve = s.gapTicket ? Math.max(min, units((opts.reserveMinutes ?? 0) / 60)) : 0;
  const room = Math.max(0, Math.min(units(s.capHours), day - reserve));
  const raw = [...minutes].map(([key, m]) => {
    const h = ((m.claude / 60) * multiplier + m.direct / 60) * factorFor(key);
    // Only touched (a commit, an issue moved): the minimum — or, measuring effort, nothing.
    return { key, raw: h > 0 ? h : s.effort ? 0 : s.minHours };
  });
  const total = raw.reduce((n, r) => n + r.raw, 0);
  const scale = total > room * s.stepHours && total > 0 ? (room * s.stepHours) / total : 1;
  let rows = raw
    .map((r) => {
      const scaled = r.raw * scale;
      const u = units(scaled);
      // Under its minimum: the minimum when it's at least a step's worth, else nothing.
      const least = minFor(r.key);
      return { key: r.key, raw: scaled, u: u >= least ? u : scaled >= s.stepHours ? least : 0, first: 0 };
    })
    .filter((r) => r.u > 0);
  for (const r of rows) r.first = r.u;
  // Rounding up to minimums can overshoot the room: trim the biggest a step at a time, then drop the smallest.
  let used = rows.reduce((n, r) => n + r.u, 0);
  const dropped: string[] = [];
  while (used > room && rows.length) {
    const big = rows.filter((r) => r.u > minFor(r.key)).sort((a, b) => b.u - a.u || a.key.localeCompare(b.key))[0];
    if (big) big.u--;
    else {
      rows = rows.sort((a, b) => a.raw - b.raw);
      dropped.push(rows[0].key);
      rows = rows.slice(1);
    }
    used = rows.reduce((n, r) => n + r.u, 0);
  }
  const entries = rows.sort((a, b) => b.u - a.u || a.key.localeCompare(b.key)).map((r) => ({ key: r.key, hours: hours(r.u) }));

  // The words: what it measured, how that became hours, and every step after (cut to fit, a minimum, trimmed).
  const why: Record<string, string> = {};
  const roomWhy =
    room === units(s.capHours) && units(s.capHours) <= day - reserve
      ? `the ${h2(s.capHours)} cap for tickets`
      : `the ${h2(s.dayHours)} day less ${h2(hours(reserve))} kept for ${s.gapTicket}${(opts.reserveMinutes ?? 0) > 0 ? ' (meetings no ticket got)' : ''}`;
  for (const r of rows) {
    const m = minutes.get(r.key)!;
    const parts: string[] = [];
    if (m.claude > 0)
      parts.push(s.effort ? `${Math.round(m.claude)} min of Claude, as measured` : `${Math.round(m.claude)} min of Claude × ${multiplier}`);
    if (m.direct > 0) parts.push(`${Math.round(m.direct)} min of meetings`);
    const measured = (m.claude / 60) * multiplier + m.direct / 60;
    const factor = factorFor(r.key);
    const steps: string[] = [
      measured > 0
        ? `${parts.join(' + ')} = ${h2(measured)}`
        : `only touched (a commit, an issue moved, a chat): the ${h2(s.minHours)} minimum`,
    ];
    if (measured > 0 && factor !== 1)
      steps.push(`× ${Math.round(factor * 100) / 100} for ${opts.points![r.key]} story points = ${h2(measured * factor)}`);
    if (scale < 1) steps.push(`all tickets came to ${h2(total)}, over ${roomWhy}: each cut to ${Math.round(scale * 100)}%`);
    const least = minFor(r.key);
    if (r.first === least && units(r.raw) < least && (measured > 0 || least > min))
      steps.push(least > min ? `raised to the ${h2(hours(least))} minimum for a task` : `raised to the ${h2(s.minHours)} minimum`);
    if (r.u < r.first) steps.push(`trimmed ${h2(hours(r.first - r.u))} so the day adds up`);
    why[r.key] = `${steps.join('; ')} → ${h2(hours(r.u))}`;
  }

  const left = day - used;
  if (s.gapTicket && left > 0) {
    why[s.gapTicket] =
      (dropped.length ? `no room left for ${dropped.join(', ')} (each under its minimum); ` : '') +
      `the rest of the ${h2(s.dayHours)} day${(opts.reserveMinutes ?? 0) > 0 ? `, ${Math.round(opts.reserveMinutes ?? 0)} min of it meetings no ticket got` : ''} → ${h2(hours(left))}`;
    return { entries: [...entries, { key: s.gapTicket, hours: hours(left) }], unallocated: 0, why };
  }
  return { entries, unallocated: hours(Math.max(0, left)), why };
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

/** Whether a string is one issue key, whole (a row's key, a configured ticket). */
export function isIssueKey(s: string): boolean {
  return new RegExp(`^${ISSUE_KEY.source}$`).test(s);
}

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
