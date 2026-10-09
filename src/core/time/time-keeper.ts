import type { ActivityLog } from '../platform/activity.js';
import { isWorkday } from './allocate.js';
import { buildDay, type TimeDeps } from './time-days.js';
import { daysBetween, localDay } from './time-view.js';
import { readDays } from './time-store.js';

/**
 * Keeps the Time tab's days current as you go (work web runs it): today
 * again after a turn ends and every half hour, and every workday of the
 * last two weeks not built yet (a day you didn't run work web, or before
 * the tab existed). Yesterday is built once more the first time today, so
 * its late turns count. One run at a time; each run says what it did in
 * the Activity panel (kind `time`).
 */

export const TIME_EVERY_MS = 30 * 60_000;
/** How far back days are caught up (the work time per day reaches two weeks). */
export const CATCH_UP_DAYS = 14;
/** A turn's end asks for today again, this long after (turns come in bursts). */
export const AFTER_TURN_MS = 2 * 60_000;

export interface TimeKeeper {
  /** Build today, and any missing day. */
  run: () => Promise<void>;
  /** Today again, soon (after a turn). */
  soon: () => void;
  stop: () => void;
}

export function createTimeKeeper(
  deps: TimeDeps,
  opts: { activity?: Pick<ActivityLog, 'start'>; changed: () => void; now?: () => number },
): TimeKeeper {
  const now = opts.now ?? (() => Date.now());
  let busy: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastToday: string | null = null;

  async function runNow(): Promise<void> {
    const today = localDay(now());
    const from = localDay(now() - (CATCH_UP_DAYS - 1) * 24 * 3600_000);
    const settings = deps.settings();
    const built = new Set(readDays(from, today).map((r) => r.day));
    const days = daysBetween(from, today).filter((d) => d === today || (!built.has(d) && isWorkday(d, settings)));
    // A new day: yesterday's last turns count too.
    if (lastToday && lastToday !== today && !days.includes(lastToday)) days.push(lastToday);
    lastToday = today;
    const run = opts.activity?.start('time', days.length === 1 ? 'Updating today' : `Building ${days.length} days`);
    try {
      for (const d of days) await buildDay(d, deps);
      opts.changed();
      run?.done(days.length === 1 ? 'today updated' : `${days.length} days built`);
    } catch (err) {
      run?.fail((err as Error).message);
    }
  }

  const run = () => {
    busy ??= runNow().finally(() => (busy = null));
    return busy;
  };
  return {
    run,
    soon: () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, AFTER_TURN_MS);
      timer.unref?.();
    },
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
