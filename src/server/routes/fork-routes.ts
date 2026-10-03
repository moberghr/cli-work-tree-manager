import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { forkSession, type ForkDeps } from '../../core/sessions/fork.js';
import { findSession } from '../../core/sessions/web-state.js';
import type { ForkWire } from '../../core/api-types.js';

/**
 * POST /api/sessions/:id/fork  {branch, prompt?, name?} — fork.ts. Slow when
 * it writes the summary (an internal Claude, up to ~90 s); the worktree is
 * created first, so a bad name fails at once.
 */
export function mountForkRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void; deps: ForkDeps }): void {
  const schema = z.object({
    branch: z.string().min(1).max(200),
    prompt: z.string().max(20_000).optional(),
    name: z.string().max(120).optional(),
  });
  app.post('/api/sessions/:id/fork', zValidator('json', schema), async (c) => {
    const parent = findSession(c.req.param('id'));
    if (!parent) return c.json({ error: 'unknown session' }, 404);
    const r = await forkSession(parent, c.req.valid('json'), opts.deps);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ sessionId: r.sessionId, paths: r.paths, summarized: r.summarized, ...(r.startError ? { startError: r.startError } : {}) } satisfies ForkWire);
  });
}
