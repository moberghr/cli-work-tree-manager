import type { Hono } from 'hono';
import { disposeSessionWatcher } from '../../core/sessions/web-state.js';
import { createCleanupJob, type CleanupJob } from '../../core/cleanup/cleanup.js';
import { defaultCleanupDeps } from '../../core/cleanup/cleanup-deps.js';
import type { CleanupApplyRequest } from '../../core/api-types.js';
import { createBuildFoldersJob, type BuildFoldersDeps } from '../../core/cleanup/build-folders-scan.js';
import { defaultBuildFoldersDeps } from '../../core/cleanup/build-folders-deps.js';
import { deleteMergedBranches, findMergedBranches, type BranchTidyDeps } from '../../core/cleanup/branch-tidy.js';
import { defaultBranchTidyDeps } from '../../core/cleanup/branch-tidy-deps.js';
import type { BranchesState } from '../../core/api-types.js';
import type { ActivityLog, RunHandle } from '../../core/platform/activity.js';

export interface CleanupRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** Tests inject a job with fake git. */
  job?: CleanupJob;
  /** Tests inject the build-folder scan's inputs. */
  buildFolders?: BuildFoldersDeps;
  /** Tests inject the branch scan's inputs. */
  branches?: BranchTidyDeps;
  /** Where the scans show (the Activity panel). */
  activity?: ActivityLog;
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
 *   GET  /api/cleanup/branches        — local branches already merged (branch-tidy.ts)
 *   POST /api/cleanup/branches/scan   — look again (asks GitHub about squash merges)
 *   POST /api/cleanup/branches/apply  — {items: [{repo, branch}]}: delete, each checked again
 *
 * GET only reads (§1.5); scanning runs git, so it is a POST.
 */
export function mountCleanupRoutes(app: Hono, opts: CleanupRoutesOptions): CleanupJob {
  // The job's phases as Activity runs: one per scan or clean-up.
  let cleanupRun: RunHandle | null = null;
  const trackCleanup = () => {
    const st = job.state();
    if (st.phase !== 'idle') {
      cleanupRun ??= opts.activity?.start('cleanup', st.phase === 'applying' ? 'Cleaning up worktrees' : 'Checking which worktrees can go') ?? null;
      cleanupRun?.progress(st.done, st.total);
      return;
    }
    if (!cleanupRun) return;
    if (st.error) cleanupRun.fail(st.error);
    else if (st.results.length) {
      for (const r of st.results) cleanupRun.note(`${r.action}: ${r.message}`, { level: r.ok ? 'action' : 'warn', sessionId: r.sessionId });
      const ok = st.results.filter((r) => r.ok).length;
      cleanupRun.done(`${ok} of ${st.results.length} done`);
    } else {
      const can = st.candidates.filter((c) => c.suggested).length;
      cleanupRun.done(`${st.candidates.length} worktrees checked · ${can} can go`);
    }
    cleanupRun = null;
  };
  const job =
    opts.job ??
    createCleanupJob({
      ...defaultCleanupDeps({ release: (id) => disposeSessionWatcher(id) }),
      onChange: () => {
        trackCleanup();
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
  const folders = createBuildFoldersJob(opts.buildFolders ?? defaultBuildFoldersDeps(), opts.activity);
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

  // Local branches already merged, left behind after their PR.
  const branchDeps = opts.branches ?? defaultBranchTidyDeps();
  let branches: BranchesState = { scanning: false, scannedAt: null, candidates: [] };
  app.get('/api/cleanup/branches', (c) => c.json(branches));
  app.post('/api/cleanup/branches/scan', (c) => {
    if (!branches.scanning) {
      branches = { ...branches, scanning: true };
      const run = opts.activity?.start('branches', 'Looking for merged local branches');
      void findMergedBranches(branchDeps)
        .then((candidates) => {
          branches = { scanning: false, scannedAt: new Date().toISOString(), candidates };
          run?.done(`${candidates.length} merged local branch${candidates.length === 1 ? '' : 'es'}`);
        })
        .catch((err: Error) => {
          branches = { ...branches, scanning: false };
          run?.fail(err.message);
        });
    }
    return c.json(branches);
  });
  app.post('/api/cleanup/branches/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { items?: unknown } | null;
    const items = Array.isArray(body?.items)
      ? body.items
          .filter((i): i is { repo: string; branch: string; tip?: unknown } => !!i && typeof i.repo === 'string' && typeof i.branch === 'string')
          .map((i) => ({ repo: i.repo, branch: i.branch, ...(typeof i.tip === 'string' ? { tip: i.tip } : {}) }))
      : [];
    if (items.length === 0) return c.json({ error: 'items: [{repo, branch, tip?}]' }, 400);
    const run = opts.activity?.start('branches', 'Deleting merged local branches');
    const results = await deleteMergedBranches(items, branchDeps);
    for (const r of results) run?.note(`${r.repo} ${r.branch}: ${r.message}`, { level: r.ok ? 'action' : 'warn' });
    run?.done(`${results.filter((r) => r.ok).length} of ${results.length} deleted`);
    const gone = new Set(results.filter((r) => r.ok).map((r) => `${r.repo}\0${r.branch}`));
    branches = { ...branches, candidates: branches.candidates.filter((b) => !gone.has(`${b.repo}\0${b.branch}`)) };
    return c.json({ results, state: branches });
  });
  return job;
}
