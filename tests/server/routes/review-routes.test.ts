import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountReviewRoutes, type ReviewRouteDeps } from '../../../src/server/routes/review-routes.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';
import type { PrReviewWire, ReviewsWire, ReviewSettingsWire } from '../../../src/core/api-types.js';

function setup(over: Partial<ReviewRouteDeps> = {}) {
  const rows = new Map<string, PrReviewWire>([['api#231', demoReview(new Date('2026-11-02T10:00:00Z'))]]);
  const broadcast = vi.fn();
  const postComment = vi.fn(async () => ({ ok: true as const, url: 'https://example/c/1' }));
  const setMode = vi.fn(async () => undefined);
  const deps: ReviewRouteDeps = {
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
    limits: () => ({ maxPerDay: 10, maxLines: 3000 }),
    today: () => 1,
    repoPath: (a) => (a === 'api' ? '/repos/api' : null),
    diff: async () => [],
    postComment,
    settings: (): ReviewSettingsWire => ({
      projects: [{ name: 'api', kind: 'repo', mode: 'all', from: 'default' }],
      maxPerDay: 10,
      maxLines: 3000,
    }),
    setMode,
    broadcast,
    ...over,
  };
  const app = new Hono();
  mountReviewRoutes(app, deps);
  const req = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { req, rows, broadcast, postComment, setMode };
}

describe('review routes', () => {
  it('lists reviews with their counts, and serves one; an unknown PR is 404', async () => {
    const { req } = setup();
    const list = (await (await req('GET', '/api/reviews')).json()) as ReviewsWire;
    expect(list.today).toBe(1);
    expect(list.reviews.map((r) => [r.number, r.status, r.stories])).toEqual([[231, 'ready', 2]]);
    expect(list.reviews[0].gaps).toBeGreaterThan(0);
    expect(((await (await req('GET', '/api/reviews/api/231')).json()) as PrReviewWire).title).toContain('Refunds');
    expect((await req('GET', '/api/reviews/api/999')).status).toBe(404);
    expect((await req('GET', '/api/reviews/api/abc')).status).toBe(404);
  });

  it("posts a draft on your click — your edit, at the review's head — and marks it posted; never twice", async () => {
    const { req, postComment, broadcast } = setup();
    const res = await req('POST', '/api/reviews/api/231/drafts/d1/post', { body: 'Guard with a row version.' });
    expect(res.status).toBe(200);
    expect(postComment).toHaveBeenCalledWith('/repos/api', 231, {
      path: 'src/Shop.Orders/Refunds/RefundHandler.cs',
      line: 6,
      body: 'Guard with a row version.',
      commitId: 'a1b2c3d',
    });
    const r = (await res.json()) as PrReviewWire;
    expect(r.drafts.find((d) => d.id === 'd1')).toMatchObject({
      state: 'posted',
      url: 'https://example/c/1',
      body: 'Guard with a row version.',
    });
    expect(broadcast).toHaveBeenCalledWith('reviews-changed', { repo: 'api', number: 231 });
    expect((await req('POST', '/api/reviews/api/231/drafts/d1/post')).status).toBe(409);
  });

  it("a host's refusal is 409 with its reason, and the draft stays a draft", async () => {
    const { req, rows } = setup({ postComment: async () => ({ ok: false, error: 'line not in the diff' }) });
    const res = await req('POST', '/api/reviews/api/231/drafts/d2/post');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'line not in the diff' });
    expect(rows.get('api#231')!.drafts.find((d) => d.id === 'd2')!.state).toBe('draft');
  });

  it('discards a draft (never a posted one), and prepares one now on a click', async () => {
    const { req, rows } = setup();
    await req('DELETE', '/api/reviews/api/231/drafts/d2');
    expect(rows.get('api#231')!.drafts.map((d) => d.id)).toEqual(['d1']);
    expect((await req('POST', '/api/reviews/api/231')).status).toBe(200);
    expect(await (await req('POST', '/api/reviews/api/7')).json()).toEqual({ error: 'not open' });
  });

  it('settings: a project and a valid mode only', async () => {
    const { req, setMode } = setup();
    expect((await req('PUT', '/api/reviews/settings', { project: 'api', mode: 'asked' })).status).toBe(200);
    expect(setMode).toHaveBeenCalledWith('api', 'asked');
    expect((await req('PUT', '/api/reviews/settings', { project: 'api', mode: 'sometimes' })).status).toBe(400);
  });

  it("the diff view: the PR's files from the stored merge-base; none prepared is 404", async () => {
    const diff = vi.fn(async () => []);
    const { req } = setup({ diff });
    expect((await req('GET', '/api/reviews/api/231/diff')).status).toBe(200);
    expect(diff).toHaveBeenCalledWith('/repos/api', 'base', 231);
    expect((await req('GET', '/api/reviews/web/1/diff')).status).toBe(404);
  });
});
