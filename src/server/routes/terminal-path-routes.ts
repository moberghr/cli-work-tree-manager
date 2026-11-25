import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { findSession } from '../../core/sessions/web-state.js';
import { openTerminalPath, resolveTerminalPath } from '../../core/worktree/terminal-paths.js';
import type { TerminalPathsWire } from '../../core/api-types.js';

/** Paths asked about in one request: a screen's worth. */
export const MAX_TERMINAL_PATHS = 50;
/** Longer than this is no path. */
export const MAX_TERMINAL_PATH_CHARS = 4096;

const pathText = z.string().min(1).max(MAX_TERMINAL_PATH_CHARS);
const resolveSchema = z.object({ paths: z.array(pathText).min(1).max(MAX_TERMINAL_PATHS) });
const openSchema = z.object({ path: pathText, how: z.enum(['default', 'editor', 'reveal']) });

/**
 * Paths in a session's terminal (terminal-paths.ts): which of the ones it printed exist, and opening one.
 *
 *   POST /api/sessions/:id/terminal-paths/resolve  {paths}      TerminalPathsWire: each path's real path, kind and how it opens
 *   POST /api/sessions/:id/terminal-paths/open     {path, how}  {ok, opened}; 404 when it is gone or ambiguous, 500 when nothing started
 *
 * Both are POST on purpose: refuseReason refuses a POST from any other site, another localhost port included (§1.5), so
 * a cross-site page cannot ask which files exist, nor open one. The server never starts a file: the default app gets
 * only the viewer types, anything else goes to the editor or is revealed. The open route resolves the path again and
 * takes nothing else from the browser.
 */
export function mountTerminalPathRoutes(app: Hono): void {
  app.post('/api/sessions/:id/terminal-paths/resolve', zValidator('json', resolveSchema), async (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const { paths } = c.req.valid('json');
    const results = await Promise.all(paths.map((raw) => resolveTerminalPath(session, raw)));
    return c.json({ results } satisfies TerminalPathsWire);
  });

  app.post('/api/sessions/:id/terminal-paths/open', zValidator('json', openSchema), async (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const { path, how } = c.req.valid('json');
    const r = await openTerminalPath(session, path, how);
    if ('ok' in r) return c.json({ ok: true, opened: r.opened });
    if (r.error === 'failed') return c.json({ error: r.message ?? 'could not open it' }, 500);
    return c.json({ error: r.error }, 404);
  });
}
