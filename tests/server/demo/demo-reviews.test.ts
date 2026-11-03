import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountDemoReviews, demoReview, demoReviewFiles } from '../../../src/server/demo/demo-reviews.js';
import { mountReviewRoutes } from '../../../src/server/routes/review-routes.js';
import type { PrReviewWire } from '../../../src/core/api-types.js';

/**
 * The demo's review routes answer as the real ones do (#64 review F018): one table of requests — reads, a draft
 * added and removed, refusals, a submit, the in-doubt and set-aside routes — run against both, statuses compared.
 */

function realApp() {
  const rows = new Map<string, PrReviewWire>([['api#231', demoReview(new Date('2026-11-02T10:00:00Z'))]]);
  const app = new Hono();
  mountReviewRoutes(app, {
    runNow: async (repo, n) =>
      rows.has(`${repo}#${n}`) ? { ok: true, review: rows.get(`${repo}#${n}`)! } : { ok: false, error: 'not open' },
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
    today: () => 1,
    repoPath: (a) => (a === 'api' ? '/repos/api' : null),
    diff: async () => demoReviewFiles(),
    submit: async () => ({ ok: true, url: 'u' }),
    settings: () => ({ projects: [], maxPerDay: null, maxLines: 3000 }),
    setMode: async () => undefined,
    broadcast: () => undefined,
  });
  return app;
}

function demoApp() {
  const app = new Hono();
  mountDemoReviews(app, () => undefined);
  return app;
}

const H = 'src/Shop.Orders/Refunds/RefundHandler.cs';
const TABLE: Array<[string, string, unknown?]> = [
  ['GET', '/api/reviews'],
  ['GET', '/api/reviews/api/231'],
  ['GET', '/api/reviews/api/999'],
  ['GET', '/api/reviews/api/231/diff'],
  ['GET', '/api/reviews/web/1/diff'],
  ['POST', '/api/reviews/api/231/drafts', { path: H, line: 6, body: 'mine' }],
  ['POST', '/api/reviews/api/231/drafts', { path: H, line: 999, body: 'off the diff' }],
  ['POST', '/api/reviews/api/231/drafts', { path: 'nope.cs', line: 1, body: 'x' }],
  ['POST', '/api/reviews/web/1/drafts', { path: H, line: 6, body: 'x' }],
  ['DELETE', '/api/reviews/api/231/drafts/u1'],
  ['DELETE', '/api/reviews/api/231/drafts/zz'],
  ['POST', '/api/reviews/api/231/submit', { event: 'merge', body: '', drafts: [] }],
  ['POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [] }],
  ['POST', '/api/reviews/api/231/submit', { event: 'comment', body: 'ok', drafts: [{ id: 'd1', body: 'x' }] }],
  ['POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'x' }] }],
  ['DELETE', '/api/reviews/api/231/drafts/d1'],
  ['POST', '/api/reviews/api/231/in-doubt', { went: true }],
  ['POST', '/api/reviews/api/231/in-doubt', { went: 'maybe' }],
  ['DELETE', '/api/reviews/api/231/dropped'],
  ['DELETE', '/api/reviews/web/1/dropped'],
  ['POST', '/api/reviews/web/1'],
  ['PUT', '/api/reviews/settings', { project: 'api', mode: 'sometimes' }],
];

describe("the demo's review routes answer as the real ones", () => {
  it('the same status for every request of the table, in order', async () => {
    const statuses = async (app: Hono) => {
      const out: string[] = [];
      for (const [method, url, body] of TABLE) {
        const res = await app.request(url, {
          method,
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        out.push(`${method} ${url} ${res.status}`);
      }
      return out;
    };
    const real = await statuses(realApp());
    expect(await statuses(demoApp())).toEqual(real);
    // And the table means something: refusals and successes both.
    expect(real).toContain('POST /api/reviews/api/231/drafts 200');
    expect(real).toContain('DELETE /api/reviews/api/231/drafts/d1 409');
    expect(real).toContain('POST /api/reviews/api/231/in-doubt 409');
  });
});
