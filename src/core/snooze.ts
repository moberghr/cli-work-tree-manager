/**
 * Snooze: "not now" for a session that wants you. While snoozed it leaves the
 * Inbox (and its count, `n`, Review all) for a section of its own, and a
 * snooze for a while holds its notifications. Three kinds:
 *
 *   2h        — two hours
 *   tomorrow  — tomorrow 9:00 (today 9:00 when it is still early morning)
 *   change    — until its status changes (a new turn, a new question, a
 *               reviewer's new comment): it notifies then, as usual
 *
 * Pure (the SPA's labels and the server's checks both use it); stored per
 * session by snooze-store.ts.
 */

export type SnoozeFor = '2h' | 'tomorrow' | 'change';

export interface Snooze {
  /** Until then (ISO); null for "until it changes". */
  until: string | null;
  /** For "until it changes": the status it was snoozed in (statusKey). */
  statusKey?: string;
  at: string;
}

/** What "its status changed" compares: Claude's state and since, and the review threads waiting. */
export function statusKey(s: { attention?: { state: string; since: string } | null; openReviewThreads?: number }): string {
  return `${s.attention?.state ?? '-'}@${s.attention?.since ?? '-'}#${s.openReviewThreads ?? 0}`;
}

/** The snooze to store for a choice, made at `now` (local time for "tomorrow"). */
export function snoozeFor(choice: SnoozeFor, subject: Parameters<typeof statusKey>[0], now = new Date()): Snooze {
  const at = now.toISOString();
  if (choice === 'change') return { until: null, statusKey: statusKey(subject), at };
  if (choice === '2h') return { until: new Date(now.getTime() + 2 * 3600_000).toISOString(), at };
  const morning = new Date(now);
  morning.setHours(9, 0, 0, 0);
  // Before 6 in the morning, "tomorrow" means the coming morning.
  if (now.getHours() >= 6) morning.setDate(morning.getDate() + 1);
  return { until: morning.toISOString(), at };
}

/** The longest a snooze for a set time may run. */
export const MAX_SNOOZE_MS = 30 * 24 * 3600_000;

/**
 * Snoozed until a time you chose ("until Friday 14:00"). Null when that time
 * isn't one: not a date, already past, or more than 30 days away (a session
 * forgotten that long belongs archived, not snoozed).
 */
export function snoozeUntil(until: string | Date, now = new Date()): Snooze | null {
  const t = until instanceof Date ? until.getTime() : Date.parse(until);
  if (!Number.isFinite(t) || t <= now.getTime() || t - now.getTime() > MAX_SNOOZE_MS) return null;
  return { until: new Date(t).toISOString(), at: now.toISOString() };
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * A time typed for `work snooze --until`, local: "14:00" (today, or
 * tomorrow when that has passed), "fri" / "fri 14:00" (the coming one, 9:00
 * by default), "+3h" / "+2d", or a date ("2026-10-03", "2026-10-03 14:00").
 * Null when it isn't one.
 */
export function parseWhen(text: string, now = new Date()): Date | null {
  const t = text.trim().toLowerCase();
  const rel = /^\+(\d+)\s*([hmd])$/.exec(t);
  if (rel) return new Date(now.getTime() + Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd']);
  const clock = (h: string, m: string | undefined, base: Date) => {
    const d = new Date(base);
    d.setHours(Number(h), Number(m ?? 0), 0, 0);
    return Number(h) < 24 && Number(m ?? 0) < 60 ? d : null;
  };
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (hm) {
    const d = clock(hm[1], hm[2], now);
    if (d && d <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  const wd = /^([a-z]{3})[a-z]*(?:\s+(\d{1,2})(?::(\d{2}))?)?$/.exec(t);
  if (wd && WEEKDAYS.includes(wd[1])) {
    const d = new Date(now);
    const ahead = (WEEKDAYS.indexOf(wd[1]) - now.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + ahead);
    return clock(wd[2] ?? '9', wd[3], d);
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(t);
  if (date) {
    const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    return clock(date[4] ?? '9', date[5], d);
  }
  return null;
}

/** Is it still snoozed: before its time, or (until it changes) still in the status it was snoozed in. */
export function snoozeActive(snooze: Snooze | null | undefined, subject: Parameters<typeof statusKey>[0], now = Date.now()): boolean {
  if (!snooze) return false;
  if (snooze.until !== null) return (Date.parse(snooze.until) || 0) > now;
  return snooze.statusKey === statusKey(subject);
}

/** For the Inbox's Snoozed section: "until 17:30", "until tomorrow 9:00", "until it changes". */
export function snoozeLabel(snooze: Pick<Snooze, 'until'>, now = new Date()): string {
  if (snooze.until === null) return 'until it changes';
  const t = new Date(snooze.until);
  const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (t.toDateString() === now.toDateString()) return `until ${time}`;
  if (t.toDateString() === tomorrow.toDateString()) return `until tomorrow ${time}`;
  return `until ${t.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}
