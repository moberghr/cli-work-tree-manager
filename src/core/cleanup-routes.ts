import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { loadHistory, removeSession, setSessionArchived } from './history.js';
import { disposeSessionWatcher, sessionIdFor } from './web-state.js';
import { disposePty } from './pty-pool.js';
import { teardownWorktree } from './worktree.js';
import { defaultRunner } from './ship.js';
import { readSessionActivity } from './claude-activity.js';
import { readStatus } from './session-status.js';
import { createCleanupJob, type CleanupDeps, type CleanupJob, type CleanupSession } from './cleanup.js';
import type { CleanupAction, CleanupApplyRequest } from './api-types.js';

export interface CleanupRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Tests inject a job with fake git. */
  job?: CleanupJob;
}

/** Newest sign of life: the hook status, Claude's last write, the entry. */
function lastActiveMs(s: { lastAccessedAt: string }, id: string, activity: number | null): number {
  const status = readStatus(id);
  return Math.max(Date.parse(s.lastAccessedAt) || 0, activity ?? 0, status ? Date.parse(status.updatedAt) || 0 : 0);
}

/** The real deps: history, config, git, and the same teardown as Delete. */
export function defaultCleanupDeps(broadcast: CleanupRoutesOptions['broadcast']): CleanupDeps {
  return {
    sessions: (): CleanupSession[] =>
      loadHistory().map((s) => {
        const id = sessionIdFor(s);
        return {
          id,
          target: s.target,
          branch: s.branch,
          isGroup: s.isGroup,
          paths: s.paths,
          archivedAt: s.archivedAt ?? null,
          lastActiveMs: lastActiveMs(s, id, readSessionActivity(s).lastActivity),
        };
      }),
    baseCheckouts: () => Object.values(loadConfig()?.repos ?? {}),
    fetchRepos: () => Object.values(loadConfig()?.repos ?? {}),
    run: defaultRunner,
    act: async (s: CleanupSession, action: CleanupAction) => {
      if (action === 'archive') {
        await disposePty(s.id);
        await setSessionArchived(s.target, s.branch, true);
        return;
      }
      if (action === 'delete') {
        const config = loadConfig();
        if (!config) throw new Error('no config');
        // Release our handles first (a live PTY's cwd blocks the delete on
        // Windows). Force skips only the "ahead of upstream" refusal: the
        // job just re-checked there is nothing uncommitted and nothing that
        // isn't in the main branch, and the branch itself is kept.
        await disposePty(s.id);
        await disposeSessionWatcher(s.id);
        if (!teardownWorktree(s.target, s.isGroup, s.branch, config, true)) throw new Error('git refused to remove the worktree.');
      }
      await removeSession(s.target, s.branch); // delete and forget
    },
    onChange: () => {
      broadcast('cleanup-changed', { ts: Date.now() });
      broadcast('sessions-changed', { ts: Date.now() });
    },
  };
}

/**
 * The Clean up view's API:
 *
 *   GET  /api/cleanup        — the job: phase, progress, candidates, results
 *   POST /api/cleanup/scan   — start a scan (fetches the repos first)
 *   POST /api/cleanup/apply  — {items: [{sessionId, action}]}; each is
 *                              re-checked on the spot before it is carried out
 *
 * GET only reads (§1.5); scanning runs git, so it is a POST.
 */
export function mountCleanupRoutes(app: Hono, opts: CleanupRoutesOptions): CleanupJob {
  const job = opts.job ?? createCleanupJob(defaultCleanupDeps(opts.broadcast));
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
