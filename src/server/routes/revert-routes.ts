import path from 'node:path';
import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { findSession } from '../../core/sessions/web-state.js';
import { revertFile, revertLines } from '../../core/diff/revert.js';
import type { ParsedFile } from '../../core/diff/diff-parse.js';
import type { WorktreeSession } from '../../core/sessions/history.js';

/**
 * POST /api/sessions/:id/revert — undo an uncommitted file or hunk, then
 * tell Claude (a published review note, delivered like any comment: pushed
 * to our own PTY now, or by the prompt/Stop hooks) so it doesn't quietly
 * put the change back.
 *
 * The client names the change (repo, path, optional new-side line range);
 * the server re-computes the session's Uncommitted diff to confirm that
 * change still exists and to get the repo root — it never trusts a root
 * or patch from the browser.
 */

const revertSchema = z.object({
  repo: z.string().min(1),
  path: z.string().min(1),
  lines: z.object({ start: z.number().int().min(0), end: z.number().int().min(0) }).optional(),
  /** Leave Claude a note about it (default true). */
  tell: z.boolean().optional(),
});

export interface RevertRoutesOptions {
  /** The session's Uncommitted diff, per repo. */
  uncommitted: (s: WorktreeSession) => Array<{ name: string; root: string; files: ParsedFile[] }>;
}

export function mountRevertRoutes(app: Hono, opts: RevertRoutesOptions): void {
  app.post('/api/sessions/:id/revert', zValidator('json', revertSchema), async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const body = c.req.valid('json');

    const repo = opts.uncommitted(session).find((r) => r.name === body.repo);
    const allowed = new Set(session.paths.map((p) => path.resolve(p).toLowerCase()));
    if (!repo || !allowed.has(path.resolve(repo.root).toLowerCase())) {
      return c.json({ error: `unknown repo: ${body.repo}` }, 404);
    }
    const file = repo.files.find((f) => f.path === body.path);
    if (!file) return c.json({ error: 'that file has no uncommitted change any more — reload the diff' }, 409);

    const lines = body.lines && body.lines.end >= body.lines.start ? body.lines : undefined;
    const out = lines ? revertLines(repo.root, file, lines.start, lines.end) : revertFile(repo.root, file);
    if (!out.ok) return c.json({ error: out.error }, out.status);

    if (body.tell !== false) {
      const where = session.isGroup ? `${repo.name}/${file.path}` : file.path;
      const what = lines ? `lines ${lines.start}–${lines.end} of \`${where}\`` : `\`${where}\``;
      await app.request(`/api/sessions/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side: 'general',
          status: 'published',
          body: `I reverted your uncommitted change to ${what} (back to HEAD). Leave it that way — don't reintroduce it unless I ask.`,
        }),
      });
    }
    return c.json({ ok: true, description: out.description });
  });
}
