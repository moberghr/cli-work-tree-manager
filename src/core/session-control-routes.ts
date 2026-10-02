import type { Hono } from 'hono';
import { findSession } from './web-state.js';
import { loadHistory } from './history.js';
import { disposePty, ensurePty, peekPty, ptyPids, readPtyScreen } from './pty-pool.js';
import { claudesBySession, readLiveClaudes } from './live-claudes.js';
import { readStatus } from './session-status.js';
import { NOTE_NUDGE } from './pending-delivery.js';
import { dbPtySessions } from './pty-sessions-file.js';
import { sendToSession, type SendDeps } from './session-control.js';
import type { AgentControlWire, ScreenWire, SendWire } from './api-types.js';

/**
 * Driving a session from outside its terminal (session-control.ts), for
 * `work send / start / stop / screen` and anything else that asks:
 *
 *   POST /api/sessions/:id/send         {text, force?} → SendWire
 *   POST /api/sessions/:id/agent/start  {force?}       → AgentControlWire (resumes its conversation)
 *   POST /api/sessions/:id/agent/stop                  → AgentControlWire
 *   GET  /api/sessions/:id/screen                      → ScreenWire (the terminal as text; nothing started)
 *
 * Answering a permission prompt is the existing POST …/answer (status-routes.ts).
 */
export interface ControlDeps extends SendDeps {
  /** Start its Claude in the host, resuming its conversation, with no first message. */
  resume: (id: string) => Promise<boolean>;
  stop: (id: string) => Promise<void>;
  screen: (id: string) => Promise<string | null>;
}

function realDeps(app: Hono): ControlDeps {
  const outside = (id: string) => {
    const hostPids = ptyPids();
    return (claudesBySession(readLiveClaudes(), loadHistory()).get(id) ?? []).some((c) => !hostPids.has(c.pid));
  };
  return {
    post: async (id, body) => {
      const res = await app.request(`/api/sessions/${encodeURIComponent(id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'general', status: 'published', body }),
      });
      if (!res.ok) throw new Error(`queueing the message failed (${res.status})`);
      const delivery = ((await res.json().catch(() => null)) as { delivery?: unknown } | null)?.delivery;
      return delivery === 'typed' || delivery === 'next-turn' ? delivery : null;
    },
    hostRuns: peekPty,
    runningOutside: outside,
    start: async (id) => !!(await ensurePty(id, { initialPrompt: NOTE_NUDGE }).catch(() => null)),
    resume: async (id) => !!(await ensurePty(id).catch(() => null)),
    state: (id) => readStatus(id)?.state ?? null,
    unsafe: (id) => !!findSession(id)?.launchedUnsafe || dbPtySessions.read()[id]?.unsafe === true,
    archived: (id) => !!findSession(id)?.archivedAt,
    stop: disposePty,
    screen: readPtyScreen,
  };
}

export function mountSessionControlRoutes(app: Hono, opts: { broadcast: (event: string, data: unknown) => void; deps?: Partial<ControlDeps> }): void {
  const deps: ControlDeps = { ...realDeps(app), ...opts.deps };
  const body = async (c: { req: { json: () => Promise<unknown> } }) => ((await c.req.json().catch(() => null)) ?? {}) as { text?: unknown; force?: unknown };

  app.post('/api/sessions/:id/send', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const b = await body(c);
    if (typeof b.text !== 'string') return c.json({ error: 'text is required' }, 400);
    const r = await sendToSession(id, b.text, deps, { force: b.force === true }).catch((err: Error) => ({ ok: false as const, status: 502 as const, error: err.message }));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ how: r.how, sentAt: r.sentAt } satisfies SendWire);
  });

  app.post('/api/sessions/:id/agent/start', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    if (s.archivedAt) return c.json({ error: 'it is archived: restore it first' }, 409);
    if (deps.hostRuns(id)) return c.json({ how: 'running' } satisfies AgentControlWire);
    // A second Claude on the same conversation broke the user's own terminal once (terminal-ws.ts).
    if (deps.runningOutside(id) && (await body(c)).force !== true) {
      return c.json({ error: 'its Claude runs in a terminal outside work; a second one would share its conversation (--force to start one anyway)' }, 409);
    }
    if (!(await deps.resume(id))) return c.json({ error: 'its Claude could not be started' }, 502);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ how: 'started' } satisfies AgentControlWire);
  });

  app.post('/api/sessions/:id/agent/stop', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    if (!deps.hostRuns(id)) {
      if (deps.runningOutside(id)) return c.json({ error: 'its Claude runs in a terminal outside work: stop it there' }, 409);
      return c.json({ how: 'not-running' } satisfies AgentControlWire);
    }
    await deps.stop(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ how: 'stopped' } satisfies AgentControlWire);
  });

  // A read: never starts anything (§1.5).
  app.get('/api/sessions/:id/screen', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    return c.json({ text: deps.hostRuns(id) ? await deps.screen(id) : null } satisfies ScreenWire);
  });
}
