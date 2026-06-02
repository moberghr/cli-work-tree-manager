import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import path from 'node:path';
import { computeDiff } from './diff-pipeline.js';
import { resolveRepoDiff } from './diff-scope.js';
import {
  commentStoreIdForScope,
  getScope,
  listScopes,
  markScopeEnded,
  registerScope,
  removeScope,
  ScopePathRejectedError,
  subscribeScope,
} from './scope-manager.js';
import { getCommentFileStore } from './comment-file-store.js';
import { commentInputSchema, submitReviewSchema } from './comment-schemas.js';
import { streamSSE } from 'hono/streaming';

export interface ScopeMountOptions {
  /** Server-level broadcast. Scope events go here too. */
  broadcast: (event: string, data: unknown) => void;
}


/**
 * Hono sub-app exposing the per-scope diff + review surface that lets
 * `wd` and `wd -c` consolidate onto the `work web` server.
 *
 * Routes:
 *   POST   /api/scopes                       — register a scope; returns
 *                                              `{ hash, diffUrl, reviewUrl }`
 *   GET    /api/scopes                       — list active scopes
 *   DELETE /api/scopes/:hash                 — deregister
 *   GET    /api/scopes/:hash/diff?base=…     — diff data (same shape as
 *                                              session diff)
 *   GET    /api/scopes/:hash/comments        — list comments
 *   POST   /api/scopes/:hash/comments        — add (zod-validated)
 *   DELETE /api/scopes/:hash/comments/:cid   — remove
 *   POST   /api/scopes/:hash/submit-review   — promote drafts
 *   POST   /api/scopes/:hash/discard-review  — drop drafts
 *   GET    /api/scopes/:hash/events          — SSE: diff-changed,
 *                                              comments-changed
 */
export function mountScopeRoutes(app: Hono, opts: ScopeMountOptions): void {
  // -- Lifecycle -----------------------------------------------------------

  app.post(
    '/api/scopes',
    zValidator(
      'json',
      z.object({
        paths: z.array(z.string().min(1)).min(1),
        label: z.string().optional(),
      }),
    ),
    (c) => {
      const { paths, label } = c.req.valid('json');
      try {
        const scope = registerScope(paths, label);
        opts.broadcast('scopes-changed', { hash: scope.hash });
        return c.json({
          hash: scope.hash,
          diffUrl: `/diff/${scope.hash}`,
          reviewUrl: `/review/${scope.hash}`,
        });
      } catch (err) {
        if (err instanceof ScopePathRejectedError) {
          return c.json({ error: err.message, rejected: err.rejected }, 403);
        }
        throw err;
      }
    },
  );

  app.get('/api/scopes', (c) => c.json({ scopes: listScopes() }));

  app.delete('/api/scopes/:hash', (c) => {
    const ok = removeScope(c.req.param('hash'));
    if (ok) opts.broadcast('scopes-changed', { hash: c.req.param('hash') });
    return c.json({ ok });
  });

  // -- Diff ----------------------------------------------------------------

  app.get('/api/scopes/:hash/diff', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const base = c.req.query('base') === 'branch' ? 'branch' : 'uncommitted';
    try {
      // Resolve each repo independently — they may have different parent
      // branches in a group worktree. Each entry carries its own
      // `resolvedBase` so the UI can label per-repo if it wants to.
      const resolved = scope.paths.map((p) => resolveRepoDiff(p, base));
      const repos = scope.paths.map((p, i) => ({
        name: path.basename(p),
        root: p,
        resolvedBase: resolved[i].resolvedBase,
        files: computeDiff({ root: p, diffArg: resolved[i].diffArg }),
      }));
      // Top-level `resolvedBase` is the primary repo's value — used for
      // the single-line "vs X" badge in the sidebar header. Mirrors what
      // session-diff returns from web-server.ts.
      const resolvedBase = resolved[0]?.resolvedBase ?? 'HEAD';
      return c.json({ scopeHash: scope.hash, base, resolvedBase, repos });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // -- Comments ------------------------------------------------------------

  function commentStore(hash: string) {
    return getCommentFileStore(commentStoreIdForScope(hash));
  }

  app.get('/api/scopes/:hash/comments', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    return c.json({
      comments: commentStore(scope.hash).snapshot(),
      ended: scope.ended,
    });
  });

  app.post(
    '/api/scopes/:hash/comments',
    zValidator('json', commentInputSchema),
    (c) => {
      const scope = getScope(c.req.param('hash'));
      if (!scope) return c.json({ error: 'unknown scope' }, 404);
      const store = commentStore(scope.hash);
      try {
        const comment = store.post(c.req.valid('json'));
        opts.broadcast('comments-changed', {
          scopeHash: scope.hash,
          id: comment.id,
        });
        return c.json({ comment, comments: store.snapshot() });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    },
  );

  app.delete('/api/scopes/:hash/comments/:cid', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const store = commentStore(scope.hash);
    const removed = store.remove(c.req.param('cid'));
    if (removed) {
      opts.broadcast('comments-changed', {
        scopeHash: scope.hash,
        deleted: c.req.param('cid'),
      });
    }
    return c.json({ comments: store.snapshot() });
  });

  app.post(
    '/api/scopes/:hash/submit-review',
    zValidator('json', submitReviewSchema),
    (c) => {
      const scope = getScope(c.req.param('hash'));
      if (!scope) return c.json({ error: 'unknown scope' }, 404);
      const store = commentStore(scope.hash);
      const result = store.submit(c.req.valid('json').summary);
      opts.broadcast('comments-changed', {
        scopeHash: scope.hash,
        submittedCount: result.drafts.length,
      });
      return c.json({
        count: result.drafts.length,
        comments: store.snapshot(),
      });
    },
  );

  app.post('/api/scopes/:hash/discard-review', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const store = commentStore(scope.hash);
    const discarded = store.discardDrafts();
    if (discarded > 0) {
      opts.broadcast('comments-changed', { scopeHash: scope.hash });
    }
    return c.json({ discarded, comments: store.snapshot() });
  });

  // End Review button hits this. Sets the scope's `ended` flag so the
  // `wd -c` CLI proxy can emit `--- review done ---` and exit on the
  // next poll. Scope itself stays alive — the browser tab keeps
  // working, reloading the URL keeps working.
  app.post('/api/scopes/:hash/done', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    const store = commentStore(scope.hash);
    const count = store.list().length;
    markScopeEnded(scope.hash);
    opts.broadcast('review-done', { scopeHash: scope.hash, count });
    return c.json({ ok: true, count });
  });

  // -- Per-scope SSE -------------------------------------------------------
  //
  // The shared /events stream already broadcasts global events; this
  // endpoint adds a scope-narrowed stream so the `wd -c` CLI can tail
  // *just* its scope's comments without filtering at the client.

  app.get('/api/scopes/:hash/events', (c) => {
    const scope = getScope(c.req.param('hash'));
    if (!scope) return c.json({ error: 'unknown scope' }, 404);
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeScope(scope.hash, () => {
        stream
          .writeSSE({
            event: 'diff-changed',
            data: JSON.stringify({ scopeHash: scope.hash }),
          })
          .catch(() => { /* */ });
      });
      await stream.writeSSE({ event: 'connected', data: '' });
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe?.();
          resolve();
        });
      });
    });
  });
}
