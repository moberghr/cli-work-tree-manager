import type { ActivityLog } from '../platform/activity.js';
import type { ReviewQueue } from './review-queue.js';
import { bestEffort } from '../platform/best-effort.js';

/**
 * When work web sweeps for PR reviews (#64): the first a few minutes after
 * start (the dashboard comes up first), then every 10 minutes, each shown
 * as a schedule in the Activity panel. Only a work web that acts (`jobs`):
 * the dev server serves the reviews and prepares none — your clicks still
 * do, through the queue's `runNow`.
 */

export const REVIEWS_FIRST_MS = 4 * 60_000;
export const REVIEWS_EVERY_MS = 10 * 60_000;

export interface ReviewSweeps {
  stop(): void;
}

export function startReviewSweeps(opts: {
  queue: Pick<ReviewQueue, 'sweep'>;
  activity?: ActivityLog;
  /** This work web acts on things (not the dev server). */
  jobs: boolean;
  /**
   * Before each sweep: what a stopped work web left settled (its submit claims taken as in doubt). Its notes go to the
   * Activity panel; a failure there doesn't stop the sweep.
   */
  tidy?: () => void;
  now?: () => number;
}): ReviewSweeps {
  if (!opts.jobs) return { stop: () => undefined };
  const now = opts.now ?? Date.now;
  const schedule = opts.activity?.schedule('reviews', 'Preparing PR reviews', REVIEWS_EVERY_MS);
  const sweep = () => {
    schedule?.next(now() + REVIEWS_EVERY_MS);
    // The sweep runs anyway and the next one tries again, but a failure is said: in the debug log and in Activity.
    bestEffort('settle the reviews a stopped work web left', () => {
      try {
        opts.tidy?.();
      } catch (err) {
        opts.activity
          ?.start('reviews', 'Settling what a stopped work web left')
          .fail(`${(err as Error).message}: the sweep runs anyway, and the next one tries again`);
        throw err;
      }
    });
    void opts.queue.sweep();
  };
  let every: ReturnType<typeof setInterval> | null = null;
  // The interval starts at the first sweep, so the next one is the 10 minutes Activity says.
  const first = setTimeout(() => {
    sweep();
    every = setInterval(sweep, REVIEWS_EVERY_MS);
    every.unref?.();
  }, REVIEWS_FIRST_MS);
  first.unref?.();
  schedule?.next(now() + REVIEWS_FIRST_MS);
  return {
    stop() {
      clearTimeout(first);
      if (every) clearInterval(every);
    },
  };
}
