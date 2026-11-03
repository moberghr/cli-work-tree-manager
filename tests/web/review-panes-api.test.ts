import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { clearReviewDropped, ReviewSubmitError, settleReviewInDoubt, submitReview } from '../../src/web/src/api/panes.js';
import { mountReviewRoutes, type ReviewRouteDeps } from '../../src/server/routes/review-routes.js';
import { demoReview } from '../../src/server/demo/demo-reviews.js';
import type { PrReviewWire } from '../../src/core/api-types.js';

/**
 * The SPA's review calls (panes.ts) against the real routes, through a fetch that hands each request to them: a
 * refused or failed submit comes back as ReviewSubmitError with the review as it now stands; settling a doubt and
 * forgetting the set-aside drafts reach the server and come back changed.
 */

afterEach(() => vi.unstubAllGlobals());

function serve(submit: ReviewRouteDeps['submit']) {
  const rows = new Map<string, PrReviewWire>([['api#231', demoReview(new Date('2026-11-02T10:00:00Z'))]]);
  const app = new Hono();
  mountReviewRoutes(app, {
    runNow: async () => ({ ok: false, error: 'x' }),
    read: (repo, n) => rows.get(`${repo}#${n}`) ?? null,
    all: () => [...rows.values()],
    update: (repo, n, change) => {
      const was = rows.get(`${repo}#${n}`);
      if (!was) return null;
      const next = change(was);
      rows.set(`${repo}#${n}`, next);
      return next;
    },
    limits: () => ({ maxPerDay: null, maxLines: 3000 }),
    today: () => 0,
    repoPath: (a) => (a === 'api' ? '/repos/api' : null),
    diff: async () => [],
    submit,
    pid: 1,
    bootedAt: () => 0,
    alive: () => true,
    settings: () => ({ projects: [], maxPerDay: null, maxLines: 3000 }),
    setMode: async () => undefined,
    broadcast: () => undefined,
  });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => app.request(url, init));
  return rows;
}

describe("the SPA's review calls", () => {
  it('a submit that may have gone out: a ReviewSubmitError carrying the review in doubt; settled, it went', async () => {
    serve(async () => ({ ok: false, error: 'gh: HTTP 502', inDoubt: { comments: [0], summary: false } }));
    const err = await submitReview('api', 231, { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'a' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ReviewSubmitError);
    expect((err as ReviewSubmitError).message).toBe('gh: HTTP 502');
    expect((err as ReviewSubmitError).review!.inDoubt).toMatchObject({ drafts: [{ id: 'd1', body: 'a' }] });
    // Refused while in doubt: the error, and no review (nothing changed).
    const again = await submitReview('api', 231, { event: 'comment', body: '', drafts: [{ id: 'd2', body: 'b' }] }).catch((e) => e);
    expect(again).toBeInstanceOf(ReviewSubmitError);
    expect((again as ReviewSubmitError).message).toContain('may have gone out');
    expect((again as ReviewSubmitError).review).toBeNull();
    const went = await settleReviewInDoubt('api', 231, true);
    expect(went.inDoubt).toBeUndefined();
    expect(went.drafts.find((d) => d.id === 'd1')!.state).toBe('posted');
    await expect(settleReviewInDoubt('api', 231, true)).rejects.toThrow('no submit of this review is in doubt');
  });

  it('a submit that went: the review back with its drafts posted; the drafts set aside are forgotten on request', async () => {
    const rows = serve(async () => ({ ok: true, url: 'https://example/r/1' }));
    const r = await submitReview('api', 231, { event: 'approve', body: 'ok', drafts: [{ id: 'd1', body: 'a' }] });
    expect(r.submitted).toMatchObject({ event: 'approve', url: 'https://example/r/1' });
    expect(rows.get('api#231')!.dropped).toHaveLength(1);
    expect((await clearReviewDropped('api', 231)).dropped).toBeUndefined();
    await expect(clearReviewDropped('web', 1)).rejects.toThrow('no review of that PR');
  });
});
