import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getCommentFileStore } from './comment-file-store.js';
import { findSession } from './web-state.js';
import { peekPty, getOrCreatePty } from './pty-pool.js';
import {
  formatPendingForPrompt,
  markDelivered,
  readPendingForSession,
} from './pending-delivery.js';
import {
  commentInputSchema,
  resolveSchema,
  submitReviewSchema,
} from './comment-schemas.js';

export interface MountOptions {
  /** Server-level broadcast — used to emit comments-changed events scoped
   *  by sessionId so the SPA can refetch the right session's comments. */
  broadcast: (event: string, data: unknown) => void;
}

/**
 * Per-session comment endpoints under `/api/sessions/:id/`. Each session's
 * comments are persisted to its own JSON file. The dashboard SPA's
 * ReviewProvider uses these endpoints when it's in `dashboard` context.
 */
export function mountSessionCommentRoutes(
  app: Hono,
  opts: MountOptions,
): void {
  function requireSession(id: string) {
    return findSession(id);
  }

  app.get('/api/sessions/:id/comments', (c) => {
    const id = c.req.param('id');
    if (!requireSession(id)) return c.json({ error: 'unknown session' }, 404);
    const store = getCommentFileStore(id);
    return c.json({ comments: store.snapshot() });
  });

  app.post(
    '/api/sessions/:id/comments',
    zValidator('json', commentInputSchema),
    (c) => {
      const id = c.req.param('id');
      if (!requireSession(id)) return c.json({ error: 'unknown session' }, 404);
      const store = getCommentFileStore(id);
      try {
        const comment = store.post(c.req.valid('json'));
        opts.broadcast('comments-changed', { sessionId: id, id: comment.id });
        // If a Claude is sitting in OUR own PTY (the Terminal tab is open
        // for this session), nudge it immediately by writing the pending
        // comments to stdin. The Stop / UserPromptSubmit hooks already
        // cover the cases where Claude is mid-turn or the user types; this
        // closes the "idle in our PTY, user not typing" case.
        deliverViaOwnedPty(id, comment.author);
        return c.json({ comment, comments: store.snapshot() });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  app.delete('/api/sessions/:id/comments/:cid', (c) => {
    const id = c.req.param('id');
    const cid = c.req.param('cid');
    if (!requireSession(id)) return c.json({ error: 'unknown session' }, 404);
    const store = getCommentFileStore(id);
    const removed = store.remove(cid);
    if (removed) opts.broadcast('comments-changed', { sessionId: id, deleted: cid });
    return c.json({ comments: store.snapshot() });
  });

  app.post(
    '/api/sessions/:id/comments/:cid/resolve',
    zValidator('json', resolveSchema),
    (c) => {
      const id = c.req.param('id');
      if (!requireSession(id)) return c.json({ error: 'unknown session' }, 404);
      const store = getCommentFileStore(id);
      const updated = store.setResolved(
        c.req.param('cid'),
        c.req.valid('json').resolved,
      );
      if (updated) opts.broadcast('comments-changed', { sessionId: id, id: updated.id });
      return c.json({ comments: store.snapshot() });
    },
  );

  app.post(
    '/api/sessions/:id/submit-review',
    zValidator('json', submitReviewSchema),
    (c) => {
      const id = c.req.param('id');
      if (!requireSession(id)) return c.json({ error: 'unknown session' }, 404);
      const store = getCommentFileStore(id);
      const result = store.submit(c.req.valid('json').summary);
      opts.broadcast('comments-changed', {
        sessionId: id,
        submittedCount: result.drafts.length,
      });
      return c.json({
        count: result.drafts.length,
        comments: store.snapshot(),
      });
    },
  );

  app.post('/api/sessions/:id/discard-review', (c) => {
    const id = c.req.param('id');
    if (!requireSession(id)) return c.json({ error: 'unknown session' }, 404);
    const store = getCommentFileStore(id);
    const discarded = store.discardDrafts();
    if (discarded > 0) opts.broadcast('comments-changed', { sessionId: id });
    return c.json({ discarded, comments: store.snapshot() });
  });
}

/**
 * If `work web` owns a live PTY for this session (the user opened the
 * Terminal tab and Claude is running there), push the pending comments
 * directly to stdin so Claude sees them without the user typing anything.
 *
 * We only push for user-authored comments — Claude-authored ones are
 * replies we already routed via the API. We deliberately don't spawn a
 * PTY here (use `peekPty`, not `getOrCreatePty`) — pushing to a freshly
 * spawned Claude is weird, and the user expects to control when Claude
 * starts.
 */
function deliverViaOwnedPty(sessionId: string, author: string): void {
  if (author !== 'user') return;
  if (!peekPty(sessionId)) return;

  const pending = readPendingForSession(sessionId);
  if (pending.length === 0) return;

  // peekPty returned true so this won't spawn — it'll return the existing
  // entry. We use getOrCreatePty because it's the only public way to get
  // the entry handle. (Could refactor to expose a pure peek that returns
  // the PooledPty, but not yet worth it.)
  const pty = getOrCreatePty(sessionId);
  if (!pty) return;

  const text = formatPendingForPrompt(pending);
  if (!text) return;

  // Mark delivered ONLY after a successful stdin write. If pty.write
  // throws (PTY exited mid-call, encoding error, anything) we leave the
  // comment as pending so the UserPromptSubmit / Stop hook can still
  // pick it up on the next Claude turn — better duplicate delivery than
  // silent loss. Writing the system reminder + newline so Claude treats
  // it as a submitted user prompt.
  try {
    pty.write(text + '\n');
  } catch {
    return;
  }
  markDelivered(
    sessionId,
    pending.map((c) => c.id),
  );
}
