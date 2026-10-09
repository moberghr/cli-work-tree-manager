import type { Hono } from 'hono';
import { findSession } from '../../core/sessions/web-state.js';
import { scopeHashForPaths } from '../../core/diff/scope-manager.js';
import type { DiffPageWire } from '../../core/api-types.js';
import type { WorktreeSession } from '../../core/sessions/session-types.js';

/**
 * A session's diff on a page of its own — the one `wd` opens (`/diff/<hash>`),
 * for a browser window beside the app:
 *
 *   POST /api/sessions/:id/diff-page   → {url}
 *
 * A POST, since the page needs the session's diff scope registered (the
 * status hook does it, but not since a restart for a session that has been
 * quiet), and a GET may not change anything (§1.5). The Diff tab asks when it
 * opens, so its "Open in browser" link is a plain link by the time it's clicked.
 */
export function mountDiffPageRoutes(app: Hono, opts: { ensureScope: (session: WorktreeSession) => unknown }): void {
  app.post('/api/sessions/:id/diff-page', (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    if (session.archivedAt) return c.json({ error: 'archived: restore it to see its diff' }, 409);
    if (!opts.ensureScope(session)) return c.json({ error: "couldn't set up its diff page" }, 500);
    return c.json<DiffPageWire>({ url: `/diff/${scopeHashForPaths(session.paths)}` });
  });
}
