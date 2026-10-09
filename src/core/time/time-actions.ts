import type { TimePostWire } from '../api-types.js';
import { dayWire, type TimeDeps } from './time-days.js';
import { readDay, updateDay } from './time-store.js';
import { postDay, type TempoApi } from './tempo.js';

/**
 * What both front-ends do to a day beyond reading it (the Time tab's routes
 * and `work timesheet`): post it to Tempo and record what Tempo has now.
 */

/** Make Tempo's day what the Time tab shows; record it. Throws when Tempo's day can't be read (then nothing changed). */
export async function postStoredDay(
  day: string,
  deps: TimeDeps,
  tempo: { api: TempoApi; accountId: string },
): Promise<Omit<TimePostWire, 'day'>> {
  if (!deps.issueId) throw new Error('no way to look issue ids up');
  const w = dayWire(day, deps.settings());
  const r = await postDay(day, w.entries, readDay(day)?.posted?.worklogs ?? [], {
    api: tempo.api,
    accountId: tempo.accountId,
    issueId: deps.issueId,
  });
  const failedKeys = new Set(r.failed.map((f) => f.key));
  updateDay(day, {
    // What Tempo has now: a row that failed isn't in it (the day reads "changed": post again).
    posted: { at: new Date().toISOString(), entries: w.entries.filter((e) => !failedKeys.has(e.key)), worklogs: r.ours },
  });
  const { ours: _ours, ...counts } = r;
  return counts;
}
