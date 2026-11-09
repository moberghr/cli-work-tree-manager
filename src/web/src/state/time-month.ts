import type { TimeDaySummary, TimeMonthLeftOut } from '../../../core/api-types.js';

/**
 * The Time tab's wording (pure): days, hours and statuses, the month's
 * name, why a day stays out of "Post the month", and how a run of posts
 * went, in a line.
 */

/** "Thu 8 Oct". */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "2.5 h". */
export function hoursText(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(2).replace(/0$/, '')} h`;
}

/** A day's status in a word. */
export function statusText(s: TimeDaySummary['status']): string {
  return {
    empty: 'not gathered yet',
    draft: 'suggested',
    edited: 'edited',
    off: 'day off',
    'not-workday': 'weekend / holiday',
    posted: 'in Tempo',
    changed: 'changed since posted',
  }[s];
}

const VIEW_KEY = 'work:time-view';

/** The Time tab's view as you last left it: Days unless it was Month (no storage, a private window: Days). */
export function readTimeView(): 'days' | 'month' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'month' ? 'month' : 'days';
  } catch {
    return 'days';
  }
}

export function writeTimeView(view: 'days' | 'month'): void {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Not kept: the tab opens on Days next time.
  }
}

/** "October 2026". */
export function monthLabel(month: string): string {
  return new Date(`${month}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** The month a day is in: "2026-10-30" → "2026-10". */
export const monthOf = (day: string) => day.slice(0, 7);

export function leftOutText(why: TimeMonthLeftOut): string {
  return {
    today: 'today, still going',
    placeholder: 'a placeholder ticket: create it in Jira first',
    posted: 'already in Tempo',
    empty: 'nothing to post',
    'not-gathered': 'not gathered yet',
    'not-workday': 'weekend or holiday: save its rows to post it',
  }[why];
}

/**
 * A cell of the Month grid typed in: the day's rows with that ticket's hours
 * changed (empty or 0: taken out; a ticket the day didn't have: added).
 * Null when nothing changed; an error when it isn't hours in whole steps.
 */
export function cellEdit(
  entries: ReadonlyArray<{ key: string; hours: number }>,
  key: string,
  text: string,
  step: number,
): { entries: Array<{ key: string; hours: number }> } | { error: string } | null {
  const t = text.trim().replace(',', '.');
  const hours = t === '' ? 0 : Number(t);
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return { error: `Not hours: ${text}` };
  if (Math.abs(hours / step - Math.round(hours / step)) > 1e-9) return { error: `Hours go in steps of ${step}: ${text}` };
  const had = entries.find((e) => e.key === key)?.hours ?? 0;
  if (hours === had) return null;
  const rest = entries.filter((e) => e.key !== key).map((e) => ({ key: e.key, hours: e.hours }));
  return {
    entries:
      hours > 0
        ? entries.some((e) => e.key === key)
          ? entries.map((e) => ({ key: e.key, hours: e.key === key ? hours : e.hours }))
          : [...rest, { key, hours }]
        : rest,
  };
}

/** One day's post: its hours, and what went wrong (the whole post, or some rows). */
export interface MonthPostResult {
  day: string;
  hours: number;
  /** The post failed: nothing of it changed in Tempo. */
  error?: string;
  /** Rows Tempo refused. */
  failed?: Array<{ key: string; error: string }>;
}

const hours = (h: number) => `${Math.round(h * 100) / 100} h`;

/** How posting the month went: "17 days posted to Tempo, 132 h. Fri 23 Oct: API-204 refused (…)." */
export function monthPostSummary(results: readonly MonthPostResult[], planned: number, label: (day: string) => string): string {
  const posted = results.filter((r) => !r.error);
  const parts = [
    `${posted.length} day${posted.length === 1 ? '' : 's'} posted to Tempo, ${hours(posted.reduce((n, r) => n + r.hours, 0))}.`,
  ];
  for (const r of results) {
    if (r.error) parts.push(`${label(r.day)} failed: ${r.error}.`);
    else if (r.failed?.length) parts.push(`${label(r.day)}: ${r.failed.map((f) => `${f.key} refused (${f.error})`).join(', ')}.`);
  }
  if (results.length < planned) parts.push(`Stopped: ${planned - results.length} not posted.`);
  return parts.join(' ');
}
