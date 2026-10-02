import os from 'node:os';
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { forkSession, type ForkDeps } from './fork.js';
import { checkedOutBranch } from './git-head.js';
import { getStatusChecked, git } from './git.js';
import type { WorktreeSession } from './session-types.js';
import { resolveProjectTarget } from './resolve.js';
import { createInProcess, type CreateWorktree } from './setup-child.js';
import { findSession, sessionIdFor } from './web-state.js';
import { startSessionWithPrompt } from './worktree-routes.js';
import type { ForkWire } from './api-types.js';

/** Uncommitted files across its repos (git status); null when git couldn't tell for one of them. */
export function uncommittedFiles(s: Pick<WorktreeSession, 'paths'>): number | null {
  let n = 0;
  for (const p of s.paths) {
    const st = getStatusChecked(p);
    if (st === null) return null;
    n += st.split('\n').filter((l) => l.trim()).length;
  }
  return n;
}

/** The real inputs of forkSession; `summarize` and `uncommitted` come from the server (catch-up, diff stats). */
export function defaultForkDeps(opts: Pick<ForkDeps, 'summarize' | 'uncommitted'> & Partial<ForkDeps> & { create?: CreateWorktree }): ForkDeps {
  return {
    config: loadConfig,
    repos: (target, config) => {
      const t = resolveProjectTarget(target, config);
      return t ? t.repoAliases.flatMap((alias) => (config.repos[alias] ? [{ alias, repoPath: config.repos[alias] }] : [])) : null;
    },
    branchOf: checkedOutBranch,
    // Branches only (a tag or a short SHA of that name is no clash).
    branchExists: (repoPath, branch) =>
      ['refs/heads/', 'refs/remotes/origin/'].some((prefix) => git(['show-ref', '--verify', '--quiet', `${prefix}${branch}`], repoPath).exitCode === 0),
    validBranch: (name) => !name.startsWith('-') && git(['check-ref-format', '--branch', name], os.tmpdir()).exitCode === 0,
    setup: async (target, branch, config, base, name) => {
      const made = await (opts.create ?? createInProcess)({ target, branch, base, name }, config);
      return made.ok ? { paths: made.paths } : { error: made.error };
    },
    start: startSessionWithPrompt,
    sessionIdFor,
    ...opts,
  };
}

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
