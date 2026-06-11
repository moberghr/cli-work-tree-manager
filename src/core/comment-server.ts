import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { createCommentStore } from './comment-store.js';
import {
  startDiffServer,
  type DiffServerApi,
  type DiffServerHandle,
} from './diff-server.js';
import type { RepoSpec } from './repo-spec.js';
import type { Comment } from './comment-types.js';
import {
  commentInputSchema,
  resolveSchema,
  submitReviewSchema,
} from './comment-schemas.js';

export type {
  Comment,
  CommentAuthor,
  CommentSide,
  CommentStatus,
} from './comment-types.js';

export interface CommentServerOptions {
  repos: RepoSpec[];
  scopeLabel: string;
  /** Session baseBranch — threaded to the diff server so `?base=branch`
   *  honours the user's recorded base instead of auto-detecting. */
  sessionBaseBranch?: string;
  /** Per-repo fork points keyed by repo root (group worktrees forked with
   *  different bases per repo). Overrides `sessionBaseBranch` per repo. */
  sessionBaseBranches?: Record<string, string>;
  onComment?: (comment: Comment) => void;
  onCommentDeleted?: (id: string) => void;
  onSubmitReviewStart?: (info: { count: number; summary: Comment | null }) => void;
  onSubmitReviewEnd?: () => void;
  watchDebounceMs?: number;
}

export interface CommentServerHandle {
  url: string;
  waitForDone(): Promise<Comment[]>;
  snapshot(): Comment[];
  stop(): Promise<void>;
}

export async function startCommentServer(
  opts: CommentServerOptions,
): Promise<CommentServerHandle> {
  const store = createCommentStore();
  let resolveDone: ((comments: Comment[]) => void) | null = null;
  const donePromise = new Promise<Comment[]>((resolve) => {
    resolveDone = resolve;
  });

  function attachRoutes(api: DiffServerApi): void {
    const routes = new Hono();

    routes.get('/api/comments', (c) => c.json({ comments: store.snapshot() }));

    routes.post(
      '/api/comments',
      zValidator('json', commentInputSchema),
      (c) => {
        try {
          const input = c.req.valid('json');
          const comment = store.post(input);
          if (
            comment.status === 'published' &&
            comment.author === 'user' &&
            opts.onComment
          ) {
            opts.onComment(comment);
          }
          if (comment.author === 'claude') {
            api.broadcast('comments-changed', { id: comment.id });
          }
          return c.json({ comment, comments: store.snapshot() });
        } catch (err) {
          return c.json({ error: (err as Error).message }, 400);
        }
      },
    );

    routes.delete('/api/comments/:id', (c) => {
      const id = c.req.param('id');
      const removed = store.remove(id);
      if (removed && opts.onCommentDeleted) opts.onCommentDeleted(id);
      return c.json({ comments: store.snapshot() });
    });

    routes.post(
      '/api/comments/:id/resolve',
      zValidator('json', resolveSchema),
      (c) => {
        const updated = store.setResolved(
          c.req.param('id'),
          c.req.valid('json').resolved,
        );
        if (updated) api.broadcast('comments-changed', { id: updated.id });
        return c.json({ comments: store.snapshot() });
      },
    );

    routes.post(
      '/api/submit-review',
      zValidator('json', submitReviewSchema),
      (c) => {
        const body = c.req.valid('json');
        const result = store.submit(body.summary);
        if (opts.onSubmitReviewStart) {
          opts.onSubmitReviewStart({
            count: result.drafts.length,
            summary: result.summary,
          });
        }
        if (result.summary && opts.onComment) opts.onComment(result.summary);
        if (opts.onComment) {
          for (const d of result.drafts) opts.onComment(d);
        }
        if (opts.onSubmitReviewEnd) opts.onSubmitReviewEnd();
        return c.json({
          count: result.drafts.length,
          comments: store.snapshot(),
        });
      },
    );

    routes.post('/api/discard-review', (c) => {
      const discarded = store.discardDrafts();
      return c.json({ discarded, comments: store.snapshot() });
    });

    routes.post('/api/done', (c) => {
      const out = c.json({ ok: true, count: store.list().length });
      if (resolveDone) {
        resolveDone(store.snapshot());
        resolveDone = null;
      }
      return out;
    });

    api.route('/', routes);
  }

  const server: DiffServerHandle = await startDiffServer({
    repos: opts.repos,
    scopeLabel: opts.scopeLabel,
    sessionBaseBranch: opts.sessionBaseBranch,
    sessionBaseBranches: opts.sessionBaseBranches,
    watchDebounceMs: opts.watchDebounceMs,
    attachRoutes,
  });

  return {
    url: server.url,
    waitForDone: () => donePromise,
    snapshot: () => store.snapshot(),
    stop: () => server.stop(),
  };
}

/** Read-only variant: diff + watch + SSE only. Used by `wd` / `wd --watch`. */
export async function startReadOnlyDiffServer(opts: {
  repos: RepoSpec[];
  scopeLabel: string;
  sessionBaseBranch?: string;
  watchDebounceMs?: number;
}): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = await startDiffServer({
    repos: opts.repos,
    scopeLabel: opts.scopeLabel,
    sessionBaseBranch: opts.sessionBaseBranch,
    watchDebounceMs: opts.watchDebounceMs,
    readOnly: true,
  });
  return { url: server.url, stop: () => server.stop() };
}

/** Format a single comment as a markdown chunk for stdout. */
export function formatSingleComment(c: Comment): string {
  const bodyLines = c.body.split('\n').map((l) => `> ${l}`).join('\n');
  const header =
    c.side === 'general'
      ? `**General review comment**`
      : c.side === 'file'
        ? `**${c.repo}/${c.file}** : whole file`
        : `**${c.repo}/${c.file}** : line ${c.line} (${c.side})`;
  const meta: string[] = [];
  if (c.author === 'claude') meta.push('author: claude');
  if (c.parentId) meta.push(`reply-to: ${c.parentId}`);
  meta.push(`id: ${c.id}`);
  return [`--- comment ---`, header, meta.join(' · '), bodyLines, ``].join('\n');
}
