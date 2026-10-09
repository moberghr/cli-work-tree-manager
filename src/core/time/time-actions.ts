import type { TimePostWire } from '../api-types.js';
import { dayWire, type TimeDeps } from './time-days.js';
import { readDay, updateDay } from './time-store.js';
import { postDay, type TempoApi } from './tempo.js';
import { loadConfig } from '../platform/config.js';
import { describeTimeDay, timeSettings } from './time-view.js';

/**
 * What both front-ends do to a day beyond reading it (the Time tab's routes
 * and `work timesheet`): post it to Tempo and record what Tempo has now.
 */

/** A day in words as it is now (state.db and the settings), for the assistant's prompt hook. */
export function describeDayNow(day: string): string {
  return describeTimeDay(dayWire(day, timeSettings(loadConfig()?.time)));
}

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
    // What you posted is what you reviewed: pinned as your rows, so a later rebuild (late turns, a new AI guess,
    // a changed setting) shows as a new suggestion beside it rather than turning the day "changed".
    // Only if the day still has no rows of yours: a save made while Tempo was being called wins.
    // And only when something of it is in Tempo now: a post that put nothing there pins nothing.
    ...(w.edited || w.dayOff || r.posted + r.kept + r.coveredByHand === 0
      ? {}
      : { editedIfUnset: w.entries.map((e) => ({ key: e.key, hours: e.hours })) }),
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
