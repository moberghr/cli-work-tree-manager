import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { getCommentFileStore } from './comment-file-store.js';
import { findSession } from './web-state.js';
import { peekPty, writeToPty } from './pty-pool.js';
import {
  formatPendingForPrompt,
  claimForDelivery,
  releaseClaim,
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
        void deliverViaOwnedPty(id, comment.author);
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
 * If `work web` owns a live PTY for this session (the user opened the
 * Terminal tab and Claude is running there), push the pending comments
 * directly to stdin so Claude sees them without the user typing anything.
 *
 * We only push for user-authored comments — Claude-authored ones are
 * replies we already routed via the API. We deliberately don't spawn a
 * PTY here (`peekPty` / `writeToPty` never spawn) — pushing to a freshly
 * spawned Claude is weird, and the user expects to control when Claude
 * starts.
 */
async function deliverViaOwnedPty(sessionId: string, author: string): Promise<void> {
  if (author !== 'user') return;
  if (!peekPty(sessionId)) return;

  const pending = readPendingForSession(sessionId);
  if (pending.length === 0) return;

  // Claim before writing, so a Stop / UserPromptSubmit hook racing us
  // can't deliver the same comments too; only what we claimed is sent. If
  // the write fails (PTY exited mid-call, PTY host unreachable, anything)
  // the claim is released, so the next hook still picks them up — no
  // silent loss. The reminder + newline makes Claude treat it as a
  // submitted user prompt.
  const claimed = new Set(claimForDelivery(sessionId, pending.map((c) => c.id)));
  const mine = pending.filter((c) => claimed.has(c.id));
  if (mine.length === 0) return;
  const text = formatPendingForPrompt(mine);
  if (!text) {
    releaseClaim(sessionId, [...claimed]);
    return;
  }
  const ok = await typeAndSubmit(sessionId, text).catch(() => false);
  if (!ok) releaseClaim(sessionId, [...claimed]);
}

/** Between the text and Enter: Claude Code takes a burst of input as a paste. */
export const SUBMIT_DELAY_MS = 250;

/**
 * Type `text` into the session's Claude prompt and submit it. Enter is `\r`
 * (what the terminal's Enter key sends); a `\n` only adds a line to the
 * prompt, which left every pushed note sitting unsent in the input box.
 * Sent apart from the text: in the same write Claude Code reads the `\r`
 * as part of the pasted block.
 */
export async function typeAndSubmit(
  sessionId: string,
  text: string,
  write: (id: string, data: string) => Promise<boolean> = writeToPty,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<boolean> {
  if (!(await write(sessionId, text))) return false;
  await wait(SUBMIT_DELAY_MS);
  return write(sessionId, '\r');
}
