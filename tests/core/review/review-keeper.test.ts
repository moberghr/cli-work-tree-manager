import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVIEWS_EVERY_MS, REVIEWS_FIRST_MS, startReviewSweeps } from '../../../src/core/review/review-keeper.js';
import { createActivityLog } from '../../../src/core/platform/activity.js';

describe('when work web sweeps', () => {
  afterEach(() => vi.useRealTimers());

  it('the first a few minutes after start, then every 10 from it — each next one when Activity says; stop ends it', () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => undefined);
    const activity = createActivityLog({ now: () => Date.now() });
    const sweeps = startReviewSweeps({ queue: { sweep }, activity, jobs: true });
    const next = () => activity.snapshot().schedules.find((s) => s.kind === 'reviews')!.nextAt;
    expect(next()).toBe(new Date(Date.now() + REVIEWS_FIRST_MS).toISOString());
    vi.advanceTimersByTime(REVIEWS_FIRST_MS - 1);
    expect(sweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    // The next one is 10 minutes from this sweep, and runs then — not 6 minutes later.
    const said = Date.parse(next()!);
    expect(said).toBe(Date.now() + REVIEWS_EVERY_MS);
    vi.advanceTimersByTime(REVIEWS_EVERY_MS - 1);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(Date.now()).toBe(said);
    expect(Date.parse(next()!)).toBe(Date.now() + REVIEWS_EVERY_MS);
    sweeps.stop();
    vi.advanceTimersByTime(REVIEWS_EVERY_MS * 3);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('stopped before the first sweep: none ever runs', () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => undefined);
    startReviewSweeps({ queue: { sweep }, jobs: true }).stop();
    vi.advanceTimersByTime(REVIEWS_EVERY_MS * 3);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('a work web that acts on nothing (the dev server) never sweeps, and shows no schedule', () => {
    vi.useFakeTimers();
    const sweep = vi.fn(async () => undefined);
    const activity = createActivityLog();
    startReviewSweeps({ queue: { sweep }, activity, jobs: false });
    vi.advanceTimersByTime(REVIEWS_EVERY_MS * 3);
    expect(sweep).not.toHaveBeenCalled();
    expect(activity.snapshot().schedules).toEqual([]);
  });
});
