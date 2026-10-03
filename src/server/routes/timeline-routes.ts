import type { Hono } from 'hono';
import { findSession } from '../../core/sessions/web-state.js';
import { sessionTimeline } from '../../core/conversations/timeline-source.js';
import type { SessionCi, TimelineWire } from '../../core/api-types.js';

/** GET /api/sessions/:id/timeline — a session's history on one line (timeline.ts). A read: git log, transcripts, the PR watch's cache. */
export function mountTimelineRoutes(app: Hono, opts: { ci?: (id: string) => SessionCi | null } = {}): void {
  app.get('/api/sessions/:id/timeline', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    return c.json({ events: await sessionTimeline(s, { ci: opts.ci?.(id) ?? null }) } satisfies TimelineWire);
  });
}
