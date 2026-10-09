import type { ActivityLog } from '../platform/activity.js';
import { isWorkday } from './allocate.js';
import { buildDay, type TimeDeps } from './time-days.js';
import { addDays, daysBetween, DEFAULT_CATCH_UP_DAYS, localDay } from './time-view.js';
import { readDays } from './time-store.js';

/**
 * Keeps the Time tab's days current as you go (work web runs it): today
 * again after a turn ends and every half hour, and every day of the last two
 * weeks whose last build was before it ended — never built (a day you didn't
 * run work web, or before the tab existed; a workday), only edited (no
 * evidence yet), or built while it was still going (its late turns count,
 * also after a night with work web closed). One run at a time; each run says
 * what it did in the Activity panel (kind `time`).
 */

export const TIME_EVERY_MS = 30 * 60_000;
/** How far back days are caught up when config `time.catchUpDays` doesn't say. */
export const CATCH_UP_DAYS = DEFAULT_CATCH_UP_DAYS;
/** A turn's end asks for today again, this long after (turns come in bursts). */
export const AFTER_TURN_MS = 2 * 60_000;

export interface TimeKeeper {
  /** Build today, and any missing day. */
  run: () => Promise<void>;
  /** Today again, soon (after a turn). */
  soon: () => void;
  stop: () => void;
}

/** When a local day ends (the next one's midnight). */
export function dayEnd(day: string): number {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function createTimeKeeper(
  deps: TimeDeps,
  opts: { activity?: Pick<ActivityLog, 'start'>; changed: () => void; now?: () => number },
): TimeKeeper {
  const now = opts.now ?? (() => Date.now());
  let busy: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runNow(): Promise<void> {
    deps.fresh?.();
    const today = localDay(now());
    const settings = deps.settings();
    const from = addDays(today, -((settings.catchUpDays ?? CATCH_UP_DAYS) - 1));
    const builtAt = new Map(readDays(from, today).map((r) => [r.day, r.builtAt]));
    const days = daysBetween(from, today).filter((d) => {
      if (d === today) return true;
      const at = builtAt.get(d);
      return at === undefined ? isWorkday(d, settings) : !at || Date.parse(at) < dayEnd(d);
    });
    const run = opts.activity?.start('time', days.length === 1 ? 'Updating today' : `Building ${days.length} days`);
    // One day that fails doesn't stop the rest; the days built are told either way.
    const failed: string[] = [];
    let built = 0;
    for (const d of days) {
      try {
        await buildDay(d, deps);
        built++;
      } catch (err) {
        failed.push(`${d}: ${(err as Error).message}`);
      }
    }
    if (built) opts.changed();
    if (failed.length) run?.fail(`${failed.length} of ${days.length} not built — ${failed.join('; ')}`);
    else run?.done(days.length === 1 ? 'today updated' : `${days.length} days built`);
  }

  // Asked while a run is under way (a turn ended, Outlook connected): that run read before it, so another follows.
  let again = false;
  const run = (): Promise<void> => {
    if (busy) {
      again = true;
      return busy;
    }
    busy = (async () => {
      do {
        again = false;
        // Never a rejection: callers fire it and forget (work web), and an unhandled one ends the process.
        await runNow().catch((err: Error) => {
          try {
            opts.activity?.start('time', 'Updating the Time tab').fail(err.message);
          } catch {
            /* nothing more to tell */
          }
        });
      } while (again);
    })().finally(() => (busy = null));
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
