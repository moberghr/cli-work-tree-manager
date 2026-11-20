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
    refreshDiscussion: async (repo, n) =>
      rows.has(`${repo}#${n}`) ? { ok: true, review: rows.get(`${repo}#${n}`)! } : { ok: false, error: 'no review' },
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
    pid: 1,
    bootedAt: () => 0,
    alive: () => true,
    settings: () => ({ projects: [], maxPerDay: null, maxLines: 3000 }),
    setMode: async () => undefined,
    broadcast: () => undefined,
    // Fix it myself as the demo's: every session new, notes go nowhere.
    fixMyself: {
      lookUp: async (r) =>
        r.fork
          ? { ok: false, error: 'a fork' }
          : {
              ok: true,
              pr: { alias: r.repo, number: r.number, title: r.title, url: r.url, branch: r.branch, base: r.base, author: r.author },
            },
      liveSessionOn: () => null,
      create: async (alias, branch) => ({ ok: true, sessionId: `${alias}-${branch}`, label: `${alias} · ${branch}` }),
      start: async () => 'started',
      note: async () => undefined,
    },
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
  ['POST', '/api/reviews/api/231/discussion'],
  ['POST', '/api/reviews/web/1/discussion'],
  ['POST', '/api/reviews/api/231/drafts', { path: H, line: 6, body: 'mine' }],
  ['POST', '/api/reviews/api/231/drafts', { path: H, line: 999, body: 'off the diff' }],
  ['POST', '/api/reviews/api/231/drafts', { path: 'nope.cs', line: 1, body: 'x' }],
  ['POST', '/api/reviews/web/1/drafts', { path: H, line: 6, body: 'x' }],
  ['DELETE', '/api/reviews/api/231/drafts/u3'],
  ['DELETE', '/api/reviews/api/231/drafts/zz'],
  ['POST', '/api/reviews/api/231/submit', { event: 'merge', body: '', drafts: [] }],
  ['POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [] }],
  ['POST', '/api/reviews/api/231/submit', { event: 'comment', body: 'ok', drafts: [{ id: 'd1', body: 'x' }] }],
  ['POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'x' }] }],
  ['DELETE', '/api/reviews/api/231/drafts/d1'],
  ['POST', '/api/reviews/api/231/fix-myself', { drafts: [] }],
  ['POST', '/api/reviews/api/231/fix-myself', { drafts: 'd2' }],
  ['POST', '/api/reviews/api/231/fix-myself', { drafts: ['zz'] }],
  ['POST', '/api/reviews/api/231/fix-myself', { drafts: ['d1'] }],
  ['POST', '/api/reviews/web/1/fix-myself', { drafts: ['d2'] }],
  ['POST', '/api/reviews/api/231/fix-myself', { drafts: ['d2'] }],
  ['POST', '/api/reviews/api/231/fix-myself', { drafts: ['d2'] }],
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
    expect(real).toContain('DELETE /api/reviews/api/231/drafts/u3 200');
    expect(real.filter((l) => l.startsWith('POST /api/reviews/api/231/fix-myself'))).toEqual([
      'POST /api/reviews/api/231/fix-myself 400',
      'POST /api/reviews/api/231/fix-myself 400',
      'POST /api/reviews/api/231/fix-myself 400',
      'POST /api/reviews/api/231/fix-myself 409', // d1 was posted
      'POST /api/reviews/api/231/fix-myself 200',
      'POST /api/reviews/api/231/fix-myself 400', // d2 left the review
    ]);
  });

  it("a demo Fix it myself: a session on the PR's branch with the instruction, or the live one told; a fork's refused", async () => {
    const made: string[] = [];
    const notes: Array<[string, string]> = [];
    let live: { id: string; label: string } | null = null;
    const app = new Hono();
    mountDemoReviews(app, () => undefined, {
      liveOn: () => live,
      create: (alias, branch) => {
        made.push(`${alias} ${branch}`);
        return { id: 'demo1', label: `${alias} · ${branch}` };
      },
      note: (id, body) => void notes.push([id, body]),
    });
    const post = (body: unknown) =>
      app.request('/api/reviews/api/231/fix-myself', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const out = (await (await post({ drafts: ['d1'] })).json()) as { sessionId: string; created: boolean; review: PrReviewWire };
    expect(out).toMatchObject({ sessionId: 'demo1', created: true });
    expect(made).toEqual(['api feat/refunds']);
    expect(notes[0][1]).toContain('4. Ask me before pushing, and push only once I say yes.');
    expect(out.review.fixingMyself?.[0]).toMatchObject({ sessionId: 'demo1', branch: 'feat/refunds' });
    expect(out.review.drafts.map((d) => d.id)).toEqual(['d2']);
    live = { id: 'live1', label: 'Refunds' };
    expect(await (await post({ drafts: ['d2'] })).json()).toMatchObject({ sessionId: 'live1', created: false });
    expect(made).toHaveLength(1);
  });

  it('a demo submit whose summary says #timeout is held in doubt, through the real flow; settled, it went', async () => {
    const app = demoApp();
    const post = (url: string, body: unknown) =>
      app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post('/api/reviews/api/231/submit', { event: 'approve', body: 'Fine #timeout', drafts: [{ id: 'd1', body: 'x' }] });
    expect(res.status).toBe(409);
    const out = (await res.json()) as { error: string; review: PrReviewWire };
    expect(out.error).toBe('the host timed out (demo)');
    expect(out.review.inDoubt).toMatchObject({ drafts: [{ id: 'd1', body: 'x' }], summary: 'Fine #timeout' });
    expect(out.review.submitting).toBeUndefined();
    expect((await post('/api/reviews/api/231/submit', { event: 'approve', body: '', drafts: [] })).status).toBe(409);
    const went = (await (await post('/api/reviews/api/231/in-doubt', { went: true })).json()) as PrReviewWire;
    expect(went.drafts.find((d) => d.id === 'd1')!.state).toBe('posted');
    expect(went.submitted).toMatchObject({ event: 'approve', summary: 'Fine #timeout' });
  });
});
