import type { Hono } from 'hono';
import type { ParsedFile } from '../../core/diff/diff-parse.js';
import type { SessionReviewWire } from '../../core/api-types.js';
import { createLocalReviews, localReviewNote, type PreparedLocal } from '../../core/review/local-review.js';
import type { WorktreeSession } from '../../core/sessions/session-types.js';
import { findSession } from '../../core/sessions/web-state.js';

/**
 * A session's own changes as a review, before there is a pull request (local-review.ts):
 *
 *   GET  /api/sessions/:id/review        the review kept for it, or that none is (reads only)
 *   POST /api/sessions/:id/review        {repo?}: prepare it now, in the background (answers "running" at once)
 *   GET  /api/sessions/:id/review/diff   the diff the kept review was made of
 *   POST /api/sessions/:id/review/send   {ids?}: hand its notes (those ids, else all) to the session's agent
 */
export interface SessionReviewDeps {
  prepare: (session: WorktreeSession, repo: string | undefined) => Promise<PreparedLocal>;
  /** Tell the session's agent (a published note, through its comments route). */
  tell: (sessionId: string, body: string) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
}

export function mountSessionReviewRoutes(app: Hono, deps: SessionReviewDeps): { drop: (sessionId: string) => void } {
  const reviews = createLocalReviews({
    prepare: deps.prepare,
    onChange: (sessionId) => deps.broadcast('session-review-changed', { sessionId }),
  });

  app.get('/api/sessions/:id/review', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    return c.json(reviews.state(id) satisfies SessionReviewWire);
  });

  app.post('/api/sessions/:id/review', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    if (session.archivedAt) return c.json({ error: 'It is archived: restore it first.' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { repo?: unknown };
    if (body.repo !== undefined && typeof body.repo !== 'string') return c.json({ error: 'repo: string' }, 400);
    return c.json(reviews.start(id, session, body.repo) satisfies SessionReviewWire);
  });

  app.get('/api/sessions/:id/review/diff', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const files = reviews.files(id);
    return files ? c.json({ files } satisfies { files: ParsedFile[] }) : c.json({ error: 'no review of it is prepared' }, 404);
  });

  app.post('/api/sessions/:id/review/send', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids =
      body.ids === undefined ? undefined : Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : null;
    if (ids === null) return c.json({ error: 'ids: string[]' }, 400);
    const review = reviews.state(id).review;
    if (!review) return c.json({ error: 'no review of it is prepared' }, 409);
    const note = localReviewNote(review, ids);
    if (!note) return c.json({ error: 'It has no notes to hand over.' }, 409);
    try {
      await deps.tell(id, note);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
    return c.json({
      ok: true,
      sent: ids
        ? ids.filter((x) => review.drafts.some((d) => d.id === x && d.state === 'draft')).length
        : review.drafts.filter((d) => d.state === 'draft').length,
    });
  });

  return { drop: reviews.drop };
}
