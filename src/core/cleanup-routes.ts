import type { Hono } from 'hono';
import { disposeSessionWatcher } from './web-state.js';
import { createCleanupJob, type CleanupJob } from './cleanup.js';
import { defaultCleanupDeps } from './cleanup-deps.js';
import type { CleanupApplyRequest } from './api-types.js';

export interface CleanupRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Tests inject a job with fake git. */
  job?: CleanupJob;
}

/**
 * The Clean up view's API (the same cleanup as `work prune` / `sync` /
 * `cleanup`, run as a job the view polls):
 *
 *   GET  /api/cleanup        — the job: phase, progress, candidates, results
 *   POST /api/cleanup/scan   — start a scan (fetches the repos first)
 *   POST /api/cleanup/apply  — {items: [{sessionId, action}]}; each is
 *                              re-checked on the spot before it is carried out
 *
 * GET only reads (§1.5); scanning runs git, so it is a POST.
 */
export function mountCleanupRoutes(app: Hono, opts: CleanupRoutesOptions): CleanupJob {
  const job =
    opts.job ??
    createCleanupJob({
      ...defaultCleanupDeps({ release: (id) => disposeSessionWatcher(id) }),
      onChange: () => {
        opts.broadcast('cleanup-changed', { ts: Date.now() });
        opts.broadcast('sessions-changed', { ts: Date.now() });
      },
    });
  app.get('/api/cleanup', (c) => c.json(job.state()));
  app.post('/api/cleanup/scan', (c) => {
    job.scan();
    return c.json(job.state());
  });
  app.post('/api/cleanup/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<CleanupApplyRequest> | null;
    const items = Array.isArray(body?.items) ? body.items : null;
    const valid = items?.every(
      (i) => i && typeof i.sessionId === 'string' && (i.action === 'delete' || i.action === 'archive' || i.action === 'forget'),
    );
    if (!items || !valid || items.length === 0) return c.json({ error: 'items: [{sessionId, action: delete|archive|forget}]' }, 400);
    if (!job.apply(items)) return c.json({ error: 'A scan or cleanup is already running.' }, 409);
    return c.json(job.state());
  });
  return job;
}
