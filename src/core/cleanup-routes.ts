import type { Hono } from 'hono';
import { disposeSessionWatcher } from './web-state.js';
import { createCleanupJob, type CleanupJob } from './cleanup.js';
import { defaultCleanupDeps } from './cleanup-deps.js';
import type { CleanupApplyRequest } from './api-types.js';
import { createBuildFoldersJob, type BuildFoldersDeps } from './build-folders-scan.js';
import { defaultBuildFoldersDeps } from './build-folders-deps.js';

export interface CleanupRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Tests inject a job with fake git. */
  job?: CleanupJob;
  /** Tests inject the build-folder scan's inputs. */
  buildFolders?: BuildFoldersDeps;
}

/**
 * The Clean up view's API (the same cleanup as `work prune` / `sync` /
 * `cleanup`, run as a job the view polls):
 *
 *   GET  /api/cleanup        — the job: phase, progress, candidates, results
 *   POST /api/cleanup/scan   — start a scan (fetches the repos first)
 *   POST /api/cleanup/apply  — {items: [{sessionId, action}]}; each is
 *                              re-checked on the spot before it is carried out
 *   GET  /api/cleanup/build-folders        — worktrees idle a week+, their
 *                                            git-ignored build folders, sized
 *   POST /api/cleanup/build-folders/scan   — look again (sizes node_modules: slow)
 *   POST /api/cleanup/build-folders/apply  — {sessionIds}: clear them
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

  // Space without archiving: build output in worktrees you haven't used for a week.
  const folders = createBuildFoldersJob(opts.buildFolders ?? defaultBuildFoldersDeps());
  app.get('/api/cleanup/build-folders', (c) => c.json(folders.state()));
  app.post('/api/cleanup/build-folders/scan', (c) => {
    folders.scan();
    return c.json(folders.state());
  });
  app.post('/api/cleanup/build-folders/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionIds?: unknown } | null;
    const ids = Array.isArray(body?.sessionIds) ? body.sessionIds.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ error: 'sessionIds: [...]' }, 400);
    const results = await folders.apply(ids);
    opts.broadcast('cleanup-changed', { ts: Date.now() });
    return c.json({ results, state: folders.state() });
  });
  return job;
}
