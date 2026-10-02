import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { discardReply, listReplies, MAX_REPLY_CHARS, postReply, saveDraft, THREAD_ID } from './pr-replies.js';
import { defaultRunner, type CommandRunner } from './ship.js';
import type { ActivityLog } from './activity.js';
import type { OpenReviewThread, PrReply, RepliesWire, SessionCi } from './api-types.js';

/** A session's unresolved review threads from the PR watch's state: open PRs only (a merged PR's threads don't wait on you). */
export function openThreadsOfCi(ci: SessionCi | null | undefined): OpenReviewThread[] {
  return (ci?.repos ?? []).filter((r) => r.pr?.state === 'OPEN').flatMap((r) => r.threads ?? []);
}

/** Open threads that have no draft to post: the panel lists them, so a count is never all you see. */
export function threadsWithoutDraft(open: OpenReviewThread[], replies: PrReply[]): OpenReviewThread[] {
  const drafted = new Set(replies.filter((r) => r.status === 'draft').map((r) => r.threadId));
  return open.filter((t) => !drafted.has(t.threadId));
}

/**
 * Replies to PR review threads (pr-replies.ts), for the session header:
 *
 *   GET    /api/sessions/:id/replies                  — the threads handed over, and Claude's drafts
 *   PUT    /api/sessions/:id/replies/:thread          — {body}: your edit of a draft
 *   DELETE /api/sessions/:id/replies/:thread          — discard (nothing is posted)
 *   POST   /api/sessions/:id/replies/:thread/post     — {body, resolve}: post it from your account
 *   POST   /api/replies-changed                       — {sessionId}: `work pr reply` saved a draft
 *
 * Posting is the only thing that writes to GitHub: here on your click, or
 * `work pr post` from the session's Claude once you said yes to the drafts.
 */
export function mountPrReplyRoutes(
  app: Hono,
  opts: {
    broadcast: (event: string, data: unknown) => void;
    run?: CommandRunner;
    activity?: ActivityLog;
    /** The session's unresolved review threads (the PR watch's last read). */
    openThreads?: (sessionId: string) => OpenReviewThread[];
  },
): void {
  const run = opts.run ?? defaultRunner;
  const changed = (sessionId: string) => {
    opts.broadcast('replies-changed', { sessionId });
    opts.broadcast('sessions-changed', { ts: Date.now() });
  };
  const body = async (c: { req: { json: () => Promise<unknown> } }) =>
    ((await c.req.json().catch(() => null)) ?? {}) as { body?: unknown; resolve?: unknown; sessionId?: unknown };

  app.get('/api/sessions/:id/replies', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const replies = listReplies(id);
    return c.json({ replies, waiting: threadsWithoutDraft(opts.openThreads?.(id) ?? [], replies) } satisfies RepliesWire);
  });

  app.put('/api/sessions/:id/replies/:thread', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const b = await body(c);
    if (typeof b.body !== 'string') return c.json({ error: 'body: string' }, 400);
    const r = saveDraft(id, c.req.param('thread'), b.body);
    if (!r.ok) return c.json({ error: r.error }, 400);
    changed(id);
    return c.json({ reply: r.reply });
  });

  app.delete('/api/sessions/:id/replies/:thread', (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    if (!THREAD_ID.test(c.req.param('thread'))) return c.json({ error: 'not a review thread id' }, 400);
    const gone = discardReply(id, c.req.param('thread'));
    changed(id);
    return c.json({ ok: gone });
  });

  app.post('/api/sessions/:id/replies/:thread/post', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const b = await body(c);
    if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > MAX_REPLY_CHARS) return c.json({ error: 'body: the reply text' }, 400);
    const thread = c.req.param('thread');
    const cwd = session.paths.find((p) => p) ?? process.cwd();
    const r = await postReply(id, thread, b.body, { resolve: b.resolve === true, cwd, run });
    if (!r.ok) return c.json({ error: r.error }, 502);
    const act = opts.activity?.start('pr-watch', 'Posting a review reply');
    act?.note(`${session.target} ${session.branch}: posted your reply${r.resolved ? ' and resolved the thread' : ''}`, { level: 'action', sessionId: id });
    act?.done(r.url);
    changed(id);
    return c.json(r);
  });

  // `work pr reply` (in the session's Claude) saved a draft: refresh the views.
  app.post('/api/replies-changed', async (c) => {
    const b = await body(c);
    if (typeof b.sessionId !== 'string' || !findSession(b.sessionId)) return c.json({ ok: false }, 404);
    changed(b.sessionId);
    return c.json({ ok: true });
  });
}
