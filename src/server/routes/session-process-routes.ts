import type { Hono } from 'hono';
import type { SessionProcessesWire } from '../../core/api-types.js';
import type { ProcessUsage } from '../../core/platform/process-usage.js';
import { sessionProcesses, stopRefusal } from '../../core/sessions/session-processes.js';
import { findSession } from '../../core/sessions/web-state.js';

/**
 * What a session's agent and the things it started hold in memory, and stopping one that was left running
 * (session-processes.ts):
 *
 *   GET  /api/sessions/:id/processes        its processes, most memory first (reads only)
 *   POST /api/sessions/:id/processes/stop   {pid, startedAt}: stop that one and what it started — only when it is
 *                                           still the process that was listed, and not the agent itself
 */
export interface SessionProcessDeps {
  /** Every process with its memory and start time; [] when they can't be read. */
  list: () => Promise<ProcessUsage[]>;
  /** The session's agent process in the PTY host, when it runs there. */
  agentPid: (sessionId: string) => number | null;
  /** Stop a process and what it started. */
  kill: (pid: number) => Promise<boolean>;
  now?: () => number;
}

/** A listing takes about a second on Windows: one serves the requests of the next few seconds. */
const LIST_FOR_MS = 3_000;

export function mountSessionProcessRoutes(app: Hono, deps: SessionProcessDeps): void {
  const now = deps.now ?? Date.now;
  let kept: { at: number; list: Promise<ProcessUsage[]> } | null = null;
  const listed = (fresh = false) => {
    if (fresh || !kept || now() - kept.at >= LIST_FOR_MS) kept = { at: now(), list: deps.list() };
    return kept.list;
  };
  const of = async (id: string, fresh = false): Promise<SessionProcessesWire | 'unknown' | 'unreadable'> => {
    const session = findSession(id);
    if (!session) return 'unknown';
    const procs = await listed(fresh);
    // None listed can't be right (this server is one): say so rather than "nothing runs".
    if (procs.length === 0) return 'unreadable';
    const pid = deps.agentPid(id);
    return sessionProcesses(procs, { agentPids: new Set(pid ? [pid] : []), dirs: session.paths, now: now() });
  };

  app.get('/api/sessions/:id/processes', async (c) => {
    const r = await of(c.req.param('id'));
    if (r === 'unknown') return c.json({ error: 'unknown session' }, 404);
    if (r === 'unreadable') return c.json({ error: "couldn't read the running processes" }, 502);
    return c.json(r);
  });

  app.post('/api/sessions/:id/processes/stop', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => null)) as { pid?: unknown; startedAt?: unknown } | null;
    if (typeof body?.pid !== 'number' || !Number.isInteger(body.pid) || body.pid <= 0)
      return c.json({ error: 'expected {pid, startedAt}' }, 400);
    // Looked at again now, never trusted from the page: the pid may be another process since it was listed.
    const r = await of(id, true);
    if (r === 'unknown') return c.json({ error: 'unknown session' }, 404);
    if (r === 'unreadable') return c.json({ error: "couldn't read the running processes" }, 502);
    const why = stopRefusal(r, body.pid, typeof body.startedAt === 'number' ? body.startedAt : null);
    if (why) return c.json({ error: `Not stopped: ${why}.` }, 409);
    if (!(await deps.kill(body.pid))) return c.json({ error: "Couldn't stop it." }, 500);
    const after = await of(id, true);
    return c.json(typeof after === 'string' ? { ...r, processes: r.processes.filter((p) => p.pid !== body.pid) } : after);
  });
}
