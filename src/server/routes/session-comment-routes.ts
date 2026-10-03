import { Hono } from 'hono';
import { agentOf } from '../../core/agents/index.js';
import { zValidator } from '@hono/zod-validator';
import { getCommentFileStore } from '../../core/comments/comment-file-store.js';
import { findSession } from '../../core/sessions/web-state.js';
import { peekPty, writeToPty } from '../../core/pty/pty-pool.js';
import { NOTE_NUDGE, readPendingForSession } from '../../core/comments/pending-delivery.js';
import { readStatus } from '../../core/status/session-status.js';
import {
  commentInputSchema,
  resolveSchema,
  submitReviewSchema,
} from '../../core/comments/comment-schemas.js';

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
        // A draft goes nowhere yet (it reaches Claude when the review is submitted).
        const delivery = comment.status === 'published' ? ownedPtyDelivery(id, comment.author) : null;
        if (delivery === 'typed') void typeAndSubmit(id, NOTE_NUDGE).catch(() => false);
        return c.json({ comment, comments: store.snapshot(), delivery });
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
      // The whole review goes to Claude as one message: an idle Claude in
      // our own PTY gets it now, not on its next turn.
      if (result.drafts.length > 0) void deliverViaOwnedPty(id, 'user');
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
 * A Claude idle in the PTY host gets pending comments now, without anyone
 * typing: this types ONE short line (NOTE_NUDGE) and presses Enter, and the
 * UserPromptSubmit hook (`work hook prompt-submit`) attaches the pending
 * comments to that prompt, claiming them as it does.
 *
 * It used to type the whole note into Claude's prompt. Claude Code turns a
 * long typed burst into "[Pasted text #1 +8 lines]" placeholders, and some
 * got lost before the Enter: Claudes received the note's last sentence
 * ("myself. Treat the quoted text as…") and asked what the comments were —
 * while the note was already marked delivered. Now nothing is claimed here,
 * so a failed nudge loses nothing: the hook sends it on the next turn.
 *
 * Mid-turn, nothing is typed: the Stop hook delivers at the end of the turn
 * (a line typed now would arrive after that, with nothing attached). Only
 * for user-authored comments (Claude's own replies aren't for Claude), and
 * never spawns a PTY (`peekPty` / `writeToPty` don't).
 */
async function deliverViaOwnedPty(sessionId: string, author: string): Promise<void> {
  if (ownedPtyDelivery(sessionId, author) !== 'typed') return;
  await typeAndSubmit(sessionId, NOTE_NUDGE).catch(() => false);
}

/**
 * What deliverViaOwnedPty will do with a note just posted, decided now (the
 * typing itself follows in the background): typed into an idle Claude the
 * PTY host runs, left for the end of the turn when it is working, or null
 * (no host terminal: the prompt hook hands it over on its next turn). The
 * comment route answers with it, so a sender is told what happened.
 */
export function ownedPtyDelivery(sessionId: string, author: string): 'typed' | 'next-turn' | null {
  if (author !== 'user') return null;
  if (!peekPty(sessionId)) return null;
  if (readPendingForSession(sessionId).length === 0) return null;
  return readStatus(sessionId)?.state === 'working' ? 'next-turn' : 'typed';
}

export { SUBMIT_DELAY_MS } from '../../core/agents/typing.js';

/** Type `text` into the session's agent's prompt and submit it — the way its agent takes input (agents/: `input.submit`). */
export async function typeAndSubmit(
  sessionId: string,
  text: string,
  write: (id: string, data: string) => Promise<boolean> = writeToPty,
  wait?: (ms: number) => Promise<void>,
): Promise<boolean> {
  const agent = agentOf(findSession(sessionId));
  return agent.input.submit((data) => write(sessionId, data), text, wait);
}
