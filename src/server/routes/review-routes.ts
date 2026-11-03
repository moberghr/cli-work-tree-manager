import type { Hono } from 'hono';
import type { ParsedFile } from '../../core/diff/diff-parse.js';
import type { SubmitReviewResult } from '../../core/hosts/types.js';
import type { PrReviewWire, ReviewEvent, ReviewSettingsWire, ReviewsWire, ReviewSubmitInput } from '../../core/api-types.js';
import {
  addDraft,
  afterFailedSubmit,
  afterSubmit,
  clearDropped,
  removeDraft,
  settleInDoubt,
  submitComments,
  submitRefusal,
  summaryToSend,
} from '../../core/review/review-submit.js';
import { summaryOf } from '../../core/review/review-build.js';
import { isReviewMode } from '../../core/review/review-config.js';

/**
 * Prepared PR reviews (#64): the list, a review, its diff, preparing one now,
 * its draft comments (the AI step's and yours), and submitting them as one
 * review — only on your click (POST …/submit), as PR replies are: one
 * submit of a review at a time; what a submit that stopped part way sent is
 * recorded and never sent again; one that may have gone out (a timed-out
 * call) waits for you to say whether it did (POST …/in-doubt) before
 * anything is sent again. The per-project settings for automatic reviews.
 * Every change broadcasts `reviews-changed`.
 */

export interface ReviewRouteDeps {
  runNow: (repo: string, number: number) => Promise<{ ok: true; review: PrReviewWire } | { ok: false; error: string }>;
  read: (repo: string, number: number) => PrReviewWire | null;
  all: () => PrReviewWire[];
  update: (repo: string, number: number, change: (r: PrReviewWire) => PrReviewWire) => PrReviewWire | null;
  limits: () => { maxPerDay: number | null; maxLines: number };
  today: () => number;
  /** A repo alias's folder (where its git and host CLI run). */
  repoPath: (alias: string) => string | null;
  /** The PR's diff from its merge-base to its fetched head. */
  diff: (repoPath: string, from: string, number: number) => Promise<ParsedFile[] | null>;
  submit: (
    repoPath: string,
    number: number,
    review: { commitId: string; event: ReviewEvent; body: string; comments: Array<{ path: string; line: number; body: string }> },
  ) => Promise<SubmitReviewResult>;
  settings: () => ReviewSettingsWire;
  setMode: (project: string, mode: 'all' | 'asked' | 'off') => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
}

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);

export function mountReviewRoutes(app: Hono, deps: ReviewRouteDeps): void {
  const changed = (repo: string, number: number) => deps.broadcast('reviews-changed', { repo, number });
  /** The reviews being submitted now: a second submit (another window, a double click) waits for none, it's refused. */
  const submitting = new Set<string>();

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
    return r ? c.json(r) : c.json({ error: 'no review of that PR' }, 404);
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
    const r = n === null ? null : deps.read(repo, n);
    const at = deps.repoPath(repo);
    if (!r || n === null || !at) return c.json({ error: 'no review of that PR' }, 404);
    const input: unknown = await c.req.json().catch(() => null);
    // Checked and taken with no await between: two requests at once can't both pass.
    const k = `${repo}#${n}`;
    if (submitting.has(k)) return c.json({ error: 'this review is being submitted already' }, 409);
    const cur = deps.read(repo, n) ?? r; // as it is after the wait for the body (a submit that just ended changed it)
    const refusal = submitRefusal(cur, input);
    if (refusal) return c.json({ error: refusal }, cur.inDoubt ? 409 : 400);
    const ok = input as ReviewSubmitInput;
    submitting.add(k);
    try {
      const res = await deps.submit(at, n, {
        commitId: cur.headSha,
        event: ok.event,
        body: summaryToSend(cur, ok),
        comments: submitComments(cur, ok),
      });
      if (!res.ok) {
        // What went out before it stopped is recorded (never sent again); what may have, waits for your word.
        const next = deps.update(repo, n, (was) => afterFailedSubmit(was, ok, res, new Date()));
        changed(repo, n);
        return c.json({ error: res.error, ...(next ? { review: next } : {}) }, 409);
      }
      const next = deps.update(repo, n, (was) => afterSubmit(was, ok, res.url, new Date()));
      changed(repo, n);
      return c.json(next);
    } finally {
      submitting.delete(k);
    }
  });

  // After a submit that may have gone out: you looked at the PR, and say whether it did.
  app.post('/api/reviews/:repo/:number/in-doubt', async (c) => {
    const repo = c.req.param('repo');
    const n = num(c.req.param('number'));
    if (n === null || !deps.read(repo, n)) return c.json({ error: 'no review of that PR' }, 404);
    const body = (await c.req.json().catch(() => null)) as { went?: unknown } | null;
    if (!body || typeof body.went !== 'boolean') return c.json({ error: 'expected {went: true|false}' }, 400);
    const went = body.went;
    let none = false;
    const next = deps.update(repo, n, (cur) => {
      const settled = settleInDoubt(cur, went, new Date());
      if (!settled) none = true;
      return settled ?? cur;
    });
    if (none || !next) return c.json({ error: 'no submit of this review is in doubt' }, 409);
    changed(repo, n);
    return c.json(next);
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
