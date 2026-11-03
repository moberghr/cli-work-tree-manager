import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountReviewRoutes, type ReviewRouteDeps } from '../../../src/server/routes/review-routes.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';
import type { PrReviewWire, ReviewFixResultWire, ReviewsWire, ReviewSettingsWire } from '../../../src/core/api-types.js';

function setup(over: Partial<ReviewRouteDeps> = {}, shared?: Map<string, PrReviewWire>) {
  const rows = shared ?? new Map<string, PrReviewWire>([['api#231', demoReview(new Date('2026-11-02T10:00:00Z'))]]);
  const broadcast = vi.fn();
  const submit = vi.fn(async () => ({ ok: true as const, url: 'https://example/review/1' }));
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
    submit,
    settings: (): ReviewSettingsWire => ({
      projects: [{ name: 'api', kind: 'repo', mode: 'all', from: 'default' }],
      maxPerDay: 10,
      maxLines: 3000,
    }),
    setMode,
    broadcast,
    pid: 1,
    bootedAt: () => 0,
    alive: () => true,
    ...over,
  };
  const app = new Hono();
  mountReviewRoutes(app, deps);
  const req = (method: string, url: string, body?: unknown) =>
    app.request(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  return { req, rows, broadcast, submit, setMode };
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

  it("submits the drafts you kept as one review — your edits, at the review's head — and marks them posted", async () => {
    const { req, submit, broadcast } = setup();
    const res = await req('POST', '/api/reviews/api/231/submit', {
      event: 'request-changes',
      body: 'Two things before this goes in.',
      drafts: [{ id: 'd1', body: 'Guard with a row version.' }],
    });
    expect(res.status).toBe(200);
    expect(submit).toHaveBeenCalledWith('/repos/api', 231, {
      commitId: 'a1b2c3d',
      event: 'request-changes',
      body: 'Two things before this goes in.',
      comments: [{ path: 'src/Shop.Orders/Refunds/RefundHandler.cs', line: 6, body: 'Guard with a row version.' }],
    });
    const r = (await res.json()) as PrReviewWire;
    expect(r.drafts.map((d) => [d.id, d.state])).toEqual([
      ['d1', 'posted'],
      ['d2', 'draft'],
    ]);
    expect(r.submitted).toMatchObject({ event: 'request-changes', url: 'https://example/review/1' });
    expect(broadcast).toHaveBeenCalledWith('reviews-changed', { repo: 'api', number: 231 });
    // A posted draft can't go again; a draft of another review, a bad verdict or an empty review are refused.
    expect(
      (await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'x' }] })).status,
    ).toBe(400);
    expect(
      (await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'zz', body: 'x' }] })).status,
    ).toBe(400);
    expect((await req('POST', '/api/reviews/api/231/submit', { event: 'merge', body: 'x', drafts: [] })).status).toBe(400);
    expect((await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: ' ', drafts: [] })).status).toBe(400);
  });

  it("a host's refusal is 409 with its reason, and the drafts stay drafts", async () => {
    const { req, rows } = setup({ submit: async () => ({ ok: false, error: 'line not in the diff' }) });
    const res = await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd2', body: 'x' }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'line not in the diff' });
    expect(rows.get('api#231')!.drafts.every((d) => d.state === 'draft')).toBe(true);
  });

  it('one submit of a review at a time: a second while one runs is refused, never sent', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const submit = vi.fn(async () => {
      await gate;
      return { ok: true as const, url: 'u' };
    });
    const { req } = setup({ submit });
    const first = req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'x' }] });
    await new Promise((r) => setTimeout(r, 5));
    const second = await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd2', body: 'y' }] });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'this review is being submitted already' });
    release();
    expect((await first).status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('the claim is in the row: a second work web on the same state.db (the dev server) is refused while one submits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const submit = vi.fn(async () => {
      await gate;
      return { ok: true as const, url: 'u' };
    });
    const one = setup({ submit, pid: 100 });
    const two = setup({ submit, pid: 200, alive: (pid) => pid === 100 }, one.rows);
    const first = one.req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'x' }] });
    await new Promise((r) => setTimeout(r, 5));
    expect(one.rows.get('api#231')!.submitting).toMatchObject({ pid: 100, event: 'comment', drafts: [{ id: 'd1', body: 'x' }] });
    const second = await two.req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd2', body: 'y' }] });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'this review is being submitted already' });
    release();
    expect((await first).status).toBe(200);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(one.rows.get('api#231')!.submitting).toBeUndefined();
  });

  it('a claim left by a work web that stopped is taken as in doubt (it may have gone out), never just dropped', async () => {
    const { req, rows, submit } = setup({ alive: () => false });
    rows.set('api#231', {
      ...rows.get('api#231')!,
      submitting: { at: new Date().toISOString(), pid: 99, event: 'approve', drafts: [{ id: 'd1', body: 'sent?' }], summary: 'S' },
    });
    const res = await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd2', body: 'y' }] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; review: PrReviewWire };
    expect(body.error).toContain('may have gone out');
    expect(body.review.submitting).toBeUndefined();
    expect(body.review.inDoubt).toMatchObject({ event: 'approve', drafts: [{ id: 'd1', body: 'sent?' }], summary: 'S', partial: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it('a host call that throws (after it may have posted) is recorded in doubt, not a 500 that leaves Submit enabled', async () => {
    const { req, rows } = setup({
      submit: async () => {
        throw new Error('EBUSY: resource busy or locked');
      },
    });
    const res = await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: 'S', drafts: [{ id: 'd1', body: 'a' }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("couldn't tell whether it went out: EBUSY: resource busy or locked");
    expect(rows.get('api#231')!.inDoubt).toMatchObject({ drafts: [{ id: 'd1', body: 'a' }], summary: 'S' });
    expect(rows.get('api#231')!.submitting).toBeUndefined();
  });

  it('not while a new push is being prepared: its lines would go on another commit', async () => {
    const { req, rows, submit } = setup();
    rows.set('api#231', { ...rows.get('api#231')!, status: 'queued' });
    const res = await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'a' }] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('being prepared again');
    expect(submit).not.toHaveBeenCalled();
  });

  it('a submit that stopped part way: what went out is posted, the retry sends only the rest (no summary twice)', async () => {
    const submit = vi
      .fn<ReviewRouteDeps['submit']>()
      .mockResolvedValueOnce({ ok: false, error: 'the summary: 500', posted: 2, summaryPosted: true })
      .mockResolvedValueOnce({ ok: true, url: 'u' });
    const { req, rows } = setup({ submit });
    const input = {
      event: 'comment',
      body: 'Two things.',
      drafts: [
        { id: 'd1', body: 'a' },
        { id: 'd2', body: 'b' },
      ],
    };
    const res = await req('POST', '/api/reviews/api/231/submit', input);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; review: PrReviewWire };
    expect(body.error).toBe('the summary: 500');
    expect(body.review.drafts.map((d) => d.state)).toEqual(['posted', 'posted']);
    expect(rows.get('api#231')!.submitted).toMatchObject({ partial: true, summary: 'Two things.' });
    // The same summary again with nothing else: only the verdict goes, not the summary a second time.
    expect((await req('POST', '/api/reviews/api/231/submit', { event: 'approve', body: 'Two things.', drafts: [] })).status).toBe(200);
    expect(submit.mock.calls[1][2]).toMatchObject({ event: 'approve', body: '', comments: [] });
  });

  it('a submit that may have gone out (timed out): nothing is sent until you say; it went, or it did not', async () => {
    const submit = vi.fn<ReviewRouteDeps['submit']>().mockResolvedValue({
      ok: false,
      error: 'gh timed out',
      inDoubt: { comments: [0], summary: false },
    });
    const { req, rows } = setup({ submit });
    await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'a' }] });
    expect(rows.get('api#231')!.inDoubt).toMatchObject({ drafts: [{ id: 'd1', body: 'a' }], error: 'gh timed out' });
    const again = await req('POST', '/api/reviews/api/231/submit', { event: 'comment', body: '', drafts: [{ id: 'd1', body: 'a' }] });
    expect(again.status).toBe(409);
    expect(submit).toHaveBeenCalledTimes(1);
    expect((await req('POST', '/api/reviews/api/231/in-doubt', { went: 'maybe' })).status).toBe(400);
    const went = await req('POST', '/api/reviews/api/231/in-doubt', { went: true });
    expect(((await went.json()) as PrReviewWire).drafts.find((d) => d.id === 'd1')!.state).toBe('posted');
    expect(rows.get('api#231')!.inDoubt).toBeUndefined();
    expect((await req('POST', '/api/reviews/api/231/in-doubt', { went: true })).status).toBe(409); // none in doubt now
    expect((await req('POST', '/api/reviews/web/1/in-doubt', { went: true })).status).toBe(404);
  });

  it('adds a draft of your own on a line of a file of the PR; anything else is refused', async () => {
    const { req, rows } = setup();
    const res = await req('POST', '/api/reviews/api/231/drafts', {
      path: 'src/Shop.Orders/Pricing/Rounding.cs',
      line: 3,
      body: 'Why away from zero?',
    });
    expect(res.status).toBe(200);
    expect(rows.get('api#231')!.drafts.at(-1)).toEqual({
      id: 'u3',
      path: 'src/Shop.Orders/Pricing/Rounding.cs',
      line: 3,
      body: 'Why away from zero?',
      state: 'draft',
      by: 'you',
    });
    expect((await req('POST', '/api/reviews/api/231/drafts', { path: 'not/in/pr.cs', line: 3, body: 'x' })).status).toBe(400);
    expect(
      (await req('POST', '/api/reviews/api/231/drafts', { path: 'src/Shop.Orders/Pricing/Rounding.cs', line: 0, body: 'x' })).status,
    ).toBe(400);
    expect((await req('POST', '/api/reviews/web/1/drafts', { path: 'a', line: 1, body: 'x' })).status).toBe(404);
  });

  it('discards a draft (never a posted one: 409; an unknown one, or review: 404), and prepares one now on a click', async () => {
    const { req, rows } = setup();
    await req('DELETE', '/api/reviews/api/231/drafts/d2');
    expect(rows.get('api#231')!.drafts.map((d) => d.id)).toEqual(['d1']);
    rows.set('api#231', { ...rows.get('api#231')!, drafts: rows.get('api#231')!.drafts.map((d) => ({ ...d, state: 'posted' as const })) });
    expect((await req('DELETE', '/api/reviews/api/231/drafts/d1')).status).toBe(409);
    expect(rows.get('api#231')!.drafts.map((d) => d.id)).toEqual(['d1']);
    expect((await req('DELETE', '/api/reviews/api/231/drafts/zz')).status).toBe(404);
    expect((await req('DELETE', '/api/reviews/web/1/drafts/d1')).status).toBe(404);
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
    const gone = setup({ diff: async () => null }); // the fetched code is gone
    expect((await gone.req('GET', '/api/reviews/api/231/diff')).status).toBe(409);
  });

  it('submit to an unknown review is 404; the drafts set aside can be forgotten', async () => {
    const { req, rows } = setup();
    expect((await req('POST', '/api/reviews/web/1/submit', { event: 'comment', body: 'x', drafts: [] })).status).toBe(404);
    expect(rows.get('api#231')!.dropped).toHaveLength(1);
    expect((await req('DELETE', '/api/reviews/api/231/dropped')).status).toBe(200);
    expect(rows.get('api#231')!.dropped).toBeUndefined();
    expect((await req('DELETE', '/api/reviews/web/1/dropped')).status).toBe(404);
  });

  it('Fix it myself: the session gets the comments, the review loses them, both lists are told; refusals say why', async () => {
    const start = vi.fn(async () => 'started');
    const fixMyself: ReviewRouteDeps['fixMyself'] = {
      lookUp: async (r) => ({
        ok: true,
        pr: { alias: r.repo, number: r.number, title: r.title, url: r.url, branch: r.branch, base: r.base, author: r.author },
      }),
      liveSessionOn: () => null,
      create: async (alias, branch) => ({ ok: true, sessionId: 'sess1', label: `${alias} · ${branch}` }),
      start,
      note: async () => undefined,
    };
    const { req, rows, broadcast } = setup({ fixMyself });
    const res = await req('POST', '/api/reviews/api/231/fix-myself', { drafts: ['d1'] });
    expect(res.status).toBe(200);
    const out = (await res.json()) as ReviewFixResultWire;
    expect(out).toMatchObject({ sessionId: 'sess1', created: true });
    expect(out.review.drafts.map((d) => d.id)).toEqual(['d2']);
    expect(rows.get('api#231')!.fixingMyself?.[0].sessionId).toBe('sess1');
    expect(start).toHaveBeenCalledWith('sess1', expect.stringContaining('Ask me before pushing'));
    expect(broadcast).toHaveBeenCalledWith('reviews-changed', { repo: 'api', number: 231 });
    expect(broadcast).toHaveBeenCalledWith('sessions-changed', expect.anything());
    expect((await req('POST', '/api/reviews/api/231/fix-myself', { drafts: ['d1'] })).status).toBe(400);
    expect((await req('POST', '/api/reviews/api/999/fix-myself', { drafts: ['d2'] })).status).toBe(404);

    // A session made whose agent took neither start nor note: the drafts stay, and the answer names the session.
    const stuck = setup({
      fixMyself: { ...fixMyself, start: async () => Promise.reject(new Error('x')), note: async () => Promise.reject(new Error('y')) },
    });
    const failed = await stuck.req('POST', '/api/reviews/api/231/fix-myself', { drafts: ['d1'] });
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ sessionId: 'sess1' });
    expect(stuck.rows.get('api#231')!.drafts).toHaveLength(2);
    expect(stuck.broadcast).toHaveBeenCalledWith('sessions-changed', expect.anything());

    // A server without it refuses.
    expect((await setup().req('POST', '/api/reviews/api/231/fix-myself', { drafts: ['d1'] })).status).toBe(501);
  });
});
