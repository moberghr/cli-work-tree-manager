import { buildDay, type TimeDeps } from './time-days.js';
import { readDays } from './time-store.js';
import { daysBetween, localDay } from './time-view.js';
import { monthRange, needsBuild } from './time-month.js';

/**
 * Gather these days (the Month view of a past month): every day of it the
 * keeper didn't reach — never gathered, or gathered before it ended — built
 * one after another in the background, the tab told after each. One gather
 * of a month at a time; how the last one failed is kept for the view.
 */

export interface MonthGather {
  /** Start gathering `month`; false when there's nothing to gather or it's under way already. */
  start: (month: string) => boolean;
  state: (month: string) => { gathering: boolean; error: string | null };
  /** Resolves when the month's gather under way (if any) is done. */
  done: (month: string) => Promise<void>;
}

export function createMonthGather(deps: TimeDeps, opts: { changed: (day: string) => void; now?: () => number }): MonthGather {
  const now = opts.now ?? (() => Date.now());
  const running = new Map<string, Promise<void>>();
  const errors = new Map<string, string>();
  return {
    start: (month) => {
      if (running.has(month)) return false;
      const today = localDay(now());
      const range = monthRange(month, today);
      if (!range) return false;
      const built = new Map(readDays(range.from, range.to).map((r) => [r.day, r.builtAt]));
      const days = daysBetween(range.from, range.to).filter((d) => d < today && needsBuild(d, built.get(d)));
      if (!days.length) return false;
      errors.delete(month);
      const p = (async () => {
        const failed: string[] = [];
        for (const d of days) {
          try {
            await buildDay(d, deps);
            opts.changed(d);
          } catch (err) {
            failed.push(`${d}: ${(err as Error).message}`);
          }
        }
        if (failed.length) errors.set(month, `${failed.length} of ${days.length} days not gathered — ${failed.join('; ')}`);
      })().finally(() => {
        running.delete(month);
        // The view's "gathering…" ends even when the last day failed.
        opts.changed(days[days.length - 1]);
      });
      running.set(month, p);
      return true;
    },
    state: (month) => ({ gathering: running.has(month), error: errors.get(month) ?? null }),
    done: (month) => running.get(month) ?? Promise.resolve(),
  };
}
