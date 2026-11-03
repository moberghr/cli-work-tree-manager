import type { Hono } from 'hono';
import type { ParsedFile } from '../../core/diff/diff-parse.js';
import type { PrReviewWire, ReviewSettingsWire, ReviewsWire } from '../../core/api-types.js';
import { addDraft, clearDropped, removeDraft } from '../../core/review/review-submit.js';
import { settlePrReview, shownReview, submitPrReview, type SubmitFlowDeps } from '../../core/review/review-submit-flow.js';
import { fixItMyself, type FixMyselfDeps } from '../../core/review/review-fix.js';
import type { ReviewFixResultWire } from '../../core/api-types.js';
import { summaryOf } from '../../core/review/review-build.js';
import { isReviewMode } from '../../core/review/review-config.js';

/**
 * Prepared PR reviews (#64): the list, a review, its diff, preparing one now,
 * its draft comments (the AI step's and yours), and submitting them as one
 * review — only on your click (POST …/submit, `submitPrReview` in core: a
 * durable claim in the review's row, so one submit at a time across
 * processes; what a submit that stopped part way sent is recorded and never
 * sent again; one that may have gone out waits for you to say whether it did
 * (POST …/in-doubt) before anything is sent again). The per-project settings
 * for automatic reviews. Fix it myself (POST …/fix-myself, `fixItMyself`
 * in core): the ticked drafts leave the review for a session on the PR's
 * branch. Every change broadcasts `reviews-changed`.
 */

export interface ReviewRouteDeps extends SubmitFlowDeps {
  runNow: (repo: string, number: number) => Promise<{ ok: true; review: PrReviewWire } | { ok: false; error: string }>;
  all: () => PrReviewWire[];
  limits: () => { maxPerDay: number | null; maxLines: number };
  today: () => number;
  /** The PR's diff from its merge-base to its fetched head. */
  diff: (repoPath: string, from: string, number: number) => Promise<ParsedFile[] | null>;
  settings: () => ReviewSettingsWire;
  setMode: (project: string, mode: 'all' | 'asked' | 'off') => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  /** Fix it myself's session side (the PR's lookup, the live session on its branch, making one, telling it); absent: refused. */
  fixMyself?: Omit<FixMyselfDeps, 'read' | 'update'>;
}

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);

export function mountReviewRoutes(app: Hono, deps: ReviewRouteDeps): void {
  const changed = (repo: string, number: number) => deps.broadcast('reviews-changed', { repo, number });

  app.get('/api/reviews', (c) => {
    const reviews = deps
      .all()
      .map(summaryOf)
      .sort((a, b) => b.at.localeCompare(a.at));
    return c.json({ reviews, today: deps.today(), maxPerDay: deps.limits().maxPerDay } satisfies ReviewsWire);
  });

  app.get('/api/reviews/settings', (c) => c.json(deps.settings()));
  app.put('/api/reviews/settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { project?: unknown; mode?: unknown } | null;
    if (!body || typeof body.project !== 'string' || !isReviewMode(body.mode))
      return c.json({ error: 'expected {project, mode: all|asked|off}' }, 400);
    try {
      await deps.setMode(body.project, body.mode);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    deps.broadcast('reviews-changed', { settings: true });
    return c.json(deps.settings());
  });

  app.get('/api/reviews/:repo/:number', (c) => {
    const n = num(c.req.param('number'));
    const r = n === null ? null : deps.read(c.req.param('repo'), n);
    // A submit claim a stopped work web left is shown stale (settle it), never "Submitting…" for good.
    return r ? c.json(shownReview(deps, r)) : c.json({ error: 'no review of that PR' }, 404);
  });

  app.get('/api/reviews/:repo/:number/diff', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    const r = n === null ? null : deps.read(repo, n);
    const at = deps.repoPath(repo);
    if (!r || n === null || !r.mergeBase || !at) return c.json({ error: 'no prepared review of that PR' }, 404);
    const files = await deps.diff(at, r.mergeBase, n);
    return files ? c.json({ files }) : c.json({ error: "git couldn't diff it (fetched code gone?): prepare it again" }, 409);
  });

  // Your click: prepare it now, whatever its size or the day's count.
  app.post('/api/reviews/:repo/:number', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null) return c.json({ error: 'not a PR number' }, 400);
    const r = await deps.runNow(repo, n);
    changed(repo, n);
    return r.ok ? c.json(r.review) : c.json({ error: r.error }, 409);
  });

  // Add a draft of your own on a line of the diff.
  app.post('/api/reviews/:repo/:number/drafts', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null || !deps.read(repo, n)) return c.json({ error: 'no review of that PR' }, 404);
    const body: unknown = await c.req.json().catch(() => null);
    let error: string | null = null;
    const next = deps.update(repo, n, (cur) => {
      const added = addDraft(cur, body);
      if ('error' in added) {
        error = added.error;
        return cur;
      }
      return added.review;
    });
    if (error) return c.json({ error }, 400);
    changed(repo, n);
    return c.json(next);
  });

  // Submit the review — the drafts you kept, a verdict and a summary, as one review in your name: only on your click.
  app.post('/api/reviews/:repo/:number/submit', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null) return c.json({ error: 'no review of that PR' }, 404);
    const input: unknown = await c.req.json().catch(() => null);
    const out = await submitPrReview(deps, repo, n, input);
    if (out.ok || out.review) changed(repo, n);
    if (out.ok) return c.json(out.review);
    return c.json({ error: out.error, ...(out.review ? { review: out.review } : {}) }, out.status);
  });

  // Fix it myself: the ticked drafts leave the review for a session on the PR's branch (made, or the live one told).
  app.post('/api/reviews/:repo/:number/fix-myself', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null || !deps.read(repo, n)) return c.json({ error: 'no review of that PR' }, 404);
    if (!deps.fixMyself) return c.json({ error: 'not available on this server' }, 501);
    const input: unknown = await c.req.json().catch(() => null);
    const out = await fixItMyself({ ...deps.fixMyself, read: deps.read, update: deps.update }, repo, n, input);
    if (out.ok || out.sessionId) deps.broadcast('sessions-changed', { ts: Date.now() });
    if (!out.ok) return c.json({ error: out.error, ...(out.sessionId ? { sessionId: out.sessionId } : {}) }, out.status);
    changed(repo, n);
    const { ok: _ok, ...wire } = out;
    return c.json(wire satisfies ReviewFixResultWire);
  });

  // After a submit that may have gone out: you looked at the PR, and say whether it did.
  app.post('/api/reviews/:repo/:number/in-doubt', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null || !deps.read(repo, n)) return c.json({ error: 'no review of that PR' }, 404);
    const body = (await c.req.json().catch(() => null)) as { went?: unknown } | null;
    if (!body || typeof body.went !== 'boolean') return c.json({ error: 'expected {went: true|false}' }, 400);
    const out = settlePrReview(deps, repo, n, body.went);
    if (!out.ok) return c.json({ error: out.error }, out.status);
    changed(repo, n);
    return c.json(out.review);
  });

  // Forget the drafts set aside (off the diff, or dropped by a new push): you copied what you wanted.
  app.delete('/api/reviews/:repo/:number/dropped', (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    const next = n === null ? null : deps.update(repo, n, clearDropped);
    if (!next || n === null) return c.json({ error: 'no review of that PR' }, 404);
    changed(repo, n);
    return c.json(next);
  });

  app.delete('/api/reviews/:repo/:number/drafts/:id', (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null || !deps.read(repo, n)) return c.json({ error: 'no review of that PR' }, 404);
    const id = c.req.param('id');
    let refused: { error: string; status: 404 | 409 } | null = null;
    const next = deps.update(repo, n, (cur) => {
      const out = removeDraft(cur, id);
      if ('error' in out) {
        refused = out;
        return cur;
      }
      return out.review;
    });
    const no = refused as { error: string; status: 404 | 409 } | null;
    if (no) return c.json({ error: no.error }, no.status);
    if (!next) return c.json({ error: 'no review of that PR' }, 404);
    changed(repo, n);
    return c.json(next);
  });
}
