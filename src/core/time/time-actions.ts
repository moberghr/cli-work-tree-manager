import type { TimePostWire } from '../api-types.js';
import { dayWire, type TimeDeps } from './time-days.js';
import { readDay, updateDay } from './time-store.js';
import { postDay, type TempoApi } from './tempo.js';

/**
 * What both front-ends do to a day beyond reading it (the Time tab's routes
 * and `work timesheet`): post it to Tempo and record what Tempo has now.
 */

/** Posts under way, per day: a second one waits for the first (two at once would both post the same rows). */
const posting = new Map<string, Promise<unknown>>();

/** Make Tempo's day what the Time tab shows; record it. Throws when Tempo's day can't be read (then nothing changed). */
export function postStoredDay(
  day: string,
  deps: TimeDeps,
  tempo: { api: TempoApi; accountId: string },
): Promise<Omit<TimePostWire, 'day'>> {
  const before = posting.get(day) ?? Promise.resolve();
  const mine = before.catch(() => {}).then(() => postNow(day, deps, tempo));
  const settled = mine.catch(() => {});
  posting.set(day, settled);
  void settled.then(() => {
    if (posting.get(day) === settled) posting.delete(day);
  });
  return mine;
}

async function postNow(day: string, deps: TimeDeps, tempo: { api: TempoApi; accountId: string }): Promise<Omit<TimePostWire, 'day'>> {
  if (!deps.issueId) throw new Error('no way to look issue ids up');
  const w = dayWire(day, deps.settings());
  const r = await postDay(day, w.entries, readDay(day)?.posted?.worklogs ?? [], {
    api: tempo.api,
    accountId: tempo.accountId,
    issueId: deps.issueId,
  });
  const failedKeys = new Set(r.failed.map((f) => f.key));
  updateDay(day, {
    // What Tempo has now: a row that failed isn't in it, an old worklog that couldn't go still is (the day reads "changed": post again).
    posted: {
      at: new Date().toISOString(),
      entries: [
        ...w.entries.filter((e) => !failedKeys.has(e.key)),
        ...r.stuck.map((s) => ({ key: s.key, hours: Math.round((s.seconds / 3600) * 100) / 100 })),
      ],
      worklogs: r.ours,
    },
  });
  const { ours: _ours, stuck: _stuck, ...counts } = r;
  return counts;
}
