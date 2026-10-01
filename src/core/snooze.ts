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
