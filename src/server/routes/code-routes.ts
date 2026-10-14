import type { Hono } from 'hono';
import { findSession } from '../../core/sessions/web-state.js';
import { listCodeFiles, readCodeFile } from '../../core/worktree/code-browse.js';

/**
 * The Code tab (code-browse.ts): a session's files, read only. Both are reads
 * with no side effects (§1.5).
 *
 *   GET /api/sessions/:id/files                  CodeFilesWire: each repo's files, the changed ones
 *   GET /api/sessions/:id/file?repo=&path=       CodeFileWire: one file as it is now
 */
export function mountCodeRoutes(app: Hono): void {
  app.get('/api/sessions/:id/files', async (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    return c.json(await listCodeFiles(session));
  });

  app.get('/api/sessions/:id/file', async (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const repo = c.req.query('repo') ?? '';
    const rel = c.req.query('path') ?? '';
    if (!rel) return c.json({ error: 'path required' }, 400);
    const r = await readCodeFile(session, repo, rel);
    if ('error' in r) return c.json({ error: r.error }, r.error === 'unreadable' ? 500 : 404);
    return c.json(r);
  });
}
