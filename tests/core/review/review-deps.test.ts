import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfigDir, getConfigPath, loadConfig } from '../../../src/core/platform/config.js';
import { setReviewMode } from '../../../src/core/worktree/repo-admin.js';
import { realReviewRouteIo, reviewSettings } from '../../../src/core/review/review-deps.js';
import { REVIEWS_EVERY_MS, REVIEWS_FIRST_MS, startReviewSweeps } from '../../../src/core/review/review-keeper.js';
import { writeReview } from '../../../src/core/review/review-store.js';
import { createActivityLog } from '../../../src/core/platform/activity.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';

// Each test file has its own HOME (tests/setup): this config.json and state.db are throwaways.

function seed(config: Record<string, unknown>) {
  fs.mkdirSync(getConfigDir(), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify({ worktreesRoot: '/wt', repos: { api: '/r/api', web: '/r/web' }, ...config }));
}
const raw = () => JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>;

describe("config's reviews block, read", () => {
  it('keeps the valid modes and limits; anything malformed is left out, not trusted', () => {
    seed({
      groups: { shop: ['api', 'web'] },
      reviews: { projects: { api: 'asked', web: 'sometimes', shop: 'off' }, maxPerDay: -1, maxLines: 0, rules: 'nope' },
    });
    expect(loadConfig()!.reviews).toEqual({ projects: { api: 'asked', shop: 'off' } });
    seed({ reviews: { projects: ['all'], maxPerDay: 3, maxLines: 500, rules: [] } });
    expect(loadConfig()!.reviews).toEqual({ maxPerDay: 3, maxLines: 500, rules: [] });
    seed({ reviews: ['all'] });
    expect(loadConfig()!.reviews).toBeUndefined();
  });
});

describe('setting a project’s mode, and the settings the Reviews tab shows', () => {
  it('a repo or a group gets its mode in config.json (the rest of the file kept); anything else is refused', async () => {
    seed({ groups: { shop: ['api', 'web'] }, someFutureSetting: { keep: true } });
    await setReviewMode('shop', 'asked');
    await setReviewMode('api', 'off');
    expect(raw().reviews).toEqual({ projects: { shop: 'asked', api: 'off' } });
    expect(raw().someFutureSetting).toEqual({ keep: true });
    await expect(setReviewMode('nope', 'all')).rejects.toThrow("nope isn't one of your repos or groups");
    expect(reviewSettings()).toEqual({
      projects: [
        { name: 'api', kind: 'repo', mode: 'off', from: 'repo' },
        { name: 'web', kind: 'repo', mode: 'asked', from: 'group', group: 'shop' },
        { name: 'shop', kind: 'group', mode: 'asked', from: 'repo' },
      ],
      maxPerDay: null,
      maxLines: 3000,
    });
  });

  it("the routes' I/O: today's count is the reviews prepared on this local day; a repo's folder by its alias", () => {
    seed({});
    const now = new Date();
    writeReview({ ...demoReview(now), number: 1, preparedAt: now.toISOString() });
    writeReview({ ...demoReview(now), number: 2, preparedAt: new Date(now.getTime() - 3 * 86_400_000).toISOString() });
    const io = realReviewRouteIo();
    expect(io.today()).toBe(1);
    expect(io.repoPath('api')).toBe('/r/api');
    expect(io.repoPath('nope')).toBeNull();
  });
});

describe('when work web sweeps', () => {
  afterEach(() => vi.useRealTimers());

  it('the first a few minutes after start, then every 10, each shown as the next in Activity; stop ends it', () => {
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
    expect(next()).toBe(new Date(Date.now() + REVIEWS_EVERY_MS).toISOString());
    vi.advanceTimersByTime(REVIEWS_EVERY_MS - REVIEWS_FIRST_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    sweeps.stop();
    vi.advanceTimersByTime(REVIEWS_EVERY_MS * 3);
    expect(sweep).toHaveBeenCalledTimes(2);
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
