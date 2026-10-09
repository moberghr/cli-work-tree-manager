import type { Hono } from 'hono';
import { describeView, writeAssistantContext } from '../../core/agents/assistant.js';
import { findSession } from '../../core/sessions/web-state.js';
import { sessionWire, type SessionWireOptions } from '../../core/sessions/session-wire.js';
import type { AssistantView } from '../../core/api-types.js';

export interface AssistantRoutesOptions {
  /** The web server's cached stats and overlaps, for the selected session. */
  wireOptions?: SessionWireOptions;
  overlapsFor?: (sessionId: string) => ReturnType<typeof sessionWire>['overlaps'];
  /** The Time tab's day in words (time-view.ts describeTimeDay), when it's on screen. */
  describeDay?: (day: string) => string;
}

/**
 *   POST /api/assistant/context — {tab, sub?, sessionId?, note?}: what the
 *   dashboard shows. Stored (in words) for the assistant's prompt hook.
 *
 * The assistant's terminal itself is the ordinary terminal WebSocket with the
 * session id `assistant` (pty-pool spawns it in its own folder).
 */
export function mountAssistantRoutes(app: Hono, opts: AssistantRoutesOptions = {}): void {
  app.post('/api/assistant/context', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<AssistantView> | null;
    if (!body || typeof body.tab !== 'string' || !body.tab) return c.json({ error: 'tab required' }, 400);
    const view: AssistantView = {
      tab: body.tab.slice(0, 40),
      ...(typeof body.sub === 'string' ? { sub: body.sub.slice(0, 40) } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...(typeof body.note === 'string' ? { note: body.note.slice(0, 500) } : {}),
      ...(typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? { day: body.day } : {}),
    };
    const s = view.sessionId ? findSession(view.sessionId) : null;
    let wire = s ? sessionWire(s, opts.wireOptions) : null;
    const o = wire ? opts.overlapsFor?.(wire.id) : undefined;
    if (wire && o) wire = { ...wire, overlaps: o };
    const day = view.tab === 'time' && view.day ? opts.describeDay?.(view.day) : undefined;
    writeAssistantContext(describeView(view, wire) + (day ? `\n${day}` : ''));
    return c.json({ ok: true });
  });
}
