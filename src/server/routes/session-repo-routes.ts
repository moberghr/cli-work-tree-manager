import fs from 'node:fs';
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { AddRepoWire } from '../../core/api-types.js';
import { agentFor } from '../../core/agents/index.js';
import { loadConfig } from '../../core/platform/config.js';
import { findSessionById } from '../../core/sessions/history.js';
import { addedRepoNote, addRepoRefusal } from '../../core/worktree/add-repo-rules.js';
import type { AddRepoRunner } from '../../core/worktree/add-repo-child.js';
import type { KeyedQueue } from '../../core/worktree/setup-child.js';

/**
 * POST /api/sessions/:id/repos  {alias, base?} — add a repo to a session
 * folder (add-repo.ts). Checking it out runs git synchronously (fetch,
 * worktree add), so it runs in a child process (add-repo-child.ts), like
 * creating a worktree, and in the same queue as creations, keyed by the repo
 * (git's own locks would make two at once in one repo fail). One add per
 * session at a time. The session's diff scope is let go before it (the child
 * moves its turn history to the new scope) and again after it (a status hook
 * meanwhile may have opened it under the old paths); then the session's
 * Claude is told by a published note.
 */

export interface SessionRepoRouteOptions {
  broadcast: (event: string, data: unknown) => void;
  run: AddRepoRunner;
  /** The queue creations run in (keyed by project; an add goes in under the repo's alias). */
  queue: KeyedQueue;
  /** Let go of the session's scope (and watcher) for these paths. */
  release: (sessionId: string, paths: string[]) => Promise<void> | void;
  /** Drop what is cached per session (diff stats, behind main). */
  invalidate: (sessionId: string) => void;
  /** Tell the session's Claude (a published general comment). */
  note: (sessionId: string, body: string) => Promise<void>;
}

/**
 * The route's `release`: let go of the session's scope under its old paths — its watch and
 * live state only. Its turn refs must stay (`clearRefs` false): the add moves them to the new
 * scope (scope-migrate.ts), and refs dropped here would be turns lost.
 */
export function scopeReleaser(
  api: { releaseSessionScope(paths: string[], clearRefs: boolean): unknown } | undefined,
): SessionRepoRouteOptions['release'] {
  return (_id, paths) => void api?.releaseSessionScope(paths, false);
}

export function mountSessionRepoRoutes(app: Hono, opts: SessionRepoRouteOptions): void {
  const schema = z.object({ alias: z.string().min(1).max(200), base: z.string().max(200).optional() });
  const running = new Set<string>();

  app.post('/api/sessions/:id/repos', zValidator('json', schema), async (c) => {
    const id = c.req.param('id');
    const { alias, base: rawBase } = c.req.valid('json');
    const base = rawBase?.trim() || undefined;
    const config = loadConfig();
    if (!config) return c.json({ error: 'no config' }, 400);
    const s = findSessionById(id);
    // The child checks again; these are the quick answers, before anything is released or spawned.
    const refusal = addRepoRefusal(s, alias, config, (p) => fs.existsSync(p), base);
    if (refusal || !s) return c.json({ error: refusal?.error ?? 'unknown session' }, refusal?.status ?? 404);
    if (running.has(id)) return c.json({ error: 'a repo is being added to this session already: wait for it' }, 409);

    running.add(id);
    try {
      const r = await opts.queue(alias, async () => {
        await opts.release(id, s.paths);
        try {
          return await opts.run(id, alias, base);
        } finally {
          // Whatever happened: a scope a status hook opened under the old paths meanwhile is let go too.
          await opts.release(id, s.paths);
        }
      });
      // Even a failure may have changed something (a refusal the child found): the list reads it again.
      opts.invalidate(id);
      opts.broadcast('sessions-changed', { ts: Date.now() });
      if (!r.ok) return c.json({ error: r.error }, r.status);
      const after = findSessionById(id) ?? s;
      const body = addedRepoNote({ alias, ...r.wire }, agentFor(config, after).instructionsFile);
      // The repo is in whatever happens to the note: one that fails is said in the answer.
      const warnings = [...(r.wire.warnings ?? [])];
      await opts.note(id, body).catch((err: Error) => warnings.push(`couldn't tell its Claude: ${err.message}`));
      return c.json({ ...r.wire, warnings } satisfies AddRepoWire);
    } catch (err) {
      return c.json({ error: `couldn't add ${alias}: ${(err as Error).message}` }, 500);
    } finally {
      running.delete(id);
    }
  });
}
