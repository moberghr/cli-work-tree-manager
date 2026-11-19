import type { Hono } from 'hono';
import type { ParsedFile } from '../../core/diff/diff-parse.js';
import type { NotifyEvent, SessionLocalReviewWire, SessionReviewCurrentWire, SessionReviewWire } from '../../core/api-types.js';
import { createLocalReviews, localReviewNote, type LocalReviewStore, type PreparedLocal } from '../../core/review/local-review.js';
import type { WorktreeSession } from '../../core/sessions/session-types.js';
import { findSession } from '../../core/sessions/web-state.js';

/**
 * A session's own changes as a review, before there is a pull request (local-review.ts):
 *
 *   GET  /api/sessions/:id/review        the review kept for it, or that none is (reads only)
 *   POST /api/sessions/:id/review        {repo?}: prepare it now, in the background (answers "running" at once)
 *   GET  /api/sessions/:id/review/diff   the diff the kept review was made of
 *   GET  /api/sessions/:id/review/current   whether it is of the changes as they are now (reads the diff: no side effect)
 *   POST /api/sessions/:id/review/send   {ids?}: hand its notes (those ids, else all not dismissed) to the session's agent
 *   POST /api/sessions/:id/review/seen   you looked at it: out of the Inbox (a POST: a GET changes nothing)
 *   POST /api/sessions/:id/review/dismiss {id, undo?}: dismiss a note you don't agree with (undo: bring it back)
 */
export interface SessionReviewDeps {
  prepare: (session: WorktreeSession, repo: string | undefined) => Promise<PreparedLocal>;
  /** The signature a review of the session's changes would have now (`repo`: the one it is of; null: all of them). */
  signature: (session: WorktreeSession, repo: string | null) => string;
  /** Tell the session's agent (a published note, through its comments route). */
  tell: (sessionId: string, body: string) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  /** Where a prepared review outlives a restart (state.db); absent: memory only. */
  store?: LocalReviewStore;
}

export function mountSessionReviewRoutes(
  app: Hono,
  deps: SessionReviewDeps,
): { drop: (sessionId: string) => void; row: (sessionId: string) => SessionLocalReviewWire | null } {
  /** The session's row changed with its review (the Inbox, the rail, its Review tab's mark). */
  const rowChanged = () => deps.broadcast('sessions-changed', { ts: Date.now() });
  const reviews = createLocalReviews({
    prepare: deps.prepare,
    onChange: (sessionId) => {
      deps.broadcast('session-review-changed', { sessionId });
      rowChanged();
      // Finished while you were elsewhere: said, as a finished turn is.
      const row = reviews.row(sessionId);
      const session = findSession(sessionId);
      if (row && session && row.status !== 'running' && !row.seen)
        deps.broadcast('notify', {
          sessionId,
          kind: 'review',
          title: `${session.title || session.branch}: ${row.status === 'ready' ? 'review ready' : 'review failed'}`,
          body: row.line,
        } satisfies NotifyEvent);
    },
    ...(deps.store ? { store: deps.store } : {}),
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
    const started = reviews.start(id, session, body.repo);
    rowChanged();
    return c.json(started satisfies SessionReviewWire);
  });

  app.post('/api/sessions/:id/review/seen', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    if (reviews.markSeen(id)) rowChanged();
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id/review/diff', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const files = reviews.files(id);
    return files ? c.json({ files } satisfies { files: ParsedFile[] }) : c.json({ error: 'no review of it is prepared' }, 404);
  });

  app.get('/api/sessions/:id/review/current', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const kept = reviews.state(id);
    if (!kept.review) return c.json({ error: 'no review of it is prepared' }, 404);
    // An archived session has no worktree to read: what it has is all there is.
    if (session.archivedAt) return c.json({ current: true } satisfies SessionReviewCurrentWire);
    let now: string;
    try {
      now = deps.signature(session, kept.repo);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
    return c.json({ current: now === kept.review.headSha } satisfies SessionReviewCurrentWire);
  });

  app.post('/api/sessions/:id/review/send', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids =
      body.ids === undefined ? undefined : Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : null;
    if (ids === null) return c.json({ error: 'ids: string[]' }, 400);
    const kept = reviews.state(id);
    const review = kept.review;
    if (!review) return c.json({ error: 'no review of it is prepared' }, 409);
    // All of them: the ones you didn't dismiss.
    const gone = new Set(kept.dismissed ?? []);
    const wanted = ids ?? review.drafts.filter((d) => d.state === 'draft' && !gone.has(d.id)).map((d) => d.id);
    const note = localReviewNote(review, wanted);
    if (!note) return c.json({ error: 'It has no notes to hand over.' }, 409);
    try {
      await deps.tell(id, note);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
    const went = wanted.filter((x) => review.drafts.some((d) => d.id === x && d.state === 'draft'));
    reviews.markSent(id, went);
    deps.broadcast('session-review-changed', { sessionId: id });
    return c.json({ ok: true, sent: went.length });
  });

  app.post('/api/sessions/:id/review/dismiss', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; undo?: unknown };
    if (typeof body.id !== 'string' || !body.id) return c.json({ error: 'id: string' }, 400);
    if (!reviews.dismiss(id, body.id, body.undo !== true)) return c.json({ error: 'no such note in the review prepared for it' }, 404);
    deps.broadcast('session-review-changed', { sessionId: id });
    return c.json(reviews.state(id) satisfies SessionReviewWire);
  });

  return { drop: reviews.drop, row: reviews.row };
}
