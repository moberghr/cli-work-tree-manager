import type { Hono } from 'hono';
import { outdatedPtys, type Restarter } from '../../core/pty/agent-restart.js';
import type { PtyInfo } from '../../core/pty/pty-host-protocol.js';
import type { AgentsWire, RestartWire } from '../../core/api-types.js';

/**
 * Restarting the agents in the PTY host (core/pty/agent-restart.ts):
 *
 *   GET  /api/agents          → AgentsWire (which run a version from before their tool updated; a read)
 *   POST /api/agents/restart  {ids: string[]} | {outdated: true} | {all: true} → RestartWire
 *
 * Restarted now when idle, after their turn when working or waiting on you.
 */
export interface AgentRestartDeps {
  /** The host's PTYs, fresh ([] without a host). */
  list: () => Promise<PtyInfo[]>;
  /** When a tool's file was installed (ms), or null. */
  installedAt: (tool: string) => number | null;
  busy: (id: string) => boolean;
  restarter: Restarter;
}

export function agentsWire(ptys: readonly PtyInfo[], deps: Pick<AgentRestartDeps, 'installedAt' | 'busy' | 'restarter'>): AgentsWire {
  const times = new Map<string, number | null>();
  const at = (tool: string) => {
    if (!times.has(tool)) times.set(tool, deps.installedAt(tool));
    return times.get(tool)!;
  };
  const outdated = outdatedPtys(ptys, at);
  const newest = Math.max(...[...new Set(ptys.map((p) => p.tool).filter((t): t is string => !!t))].map((t) => at(t) ?? -Infinity));
  return {
    installedAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    outdated: outdated.map((p) => ({ id: p.id, tool: p.tool!, startedAt: p.startedAt, busy: deps.busy(p.id) })),
    queued: deps.restarter.queued(),
  };
}

export function mountAgentRestartRoutes(app: Hono, opts: { deps: AgentRestartDeps }): void {
  const { deps } = opts;

  app.get('/api/agents', async (c) => c.json(agentsWire(await deps.list().catch(() => []), deps) satisfies AgentsWire));

  app.post('/api/agents/restart', async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as { ids?: unknown; outdated?: unknown; all?: unknown };
    const live = (await deps.list().catch(() => [])).filter((p) => !p.exited);
    let ids: string[];
    if (body.all === true) ids = live.map((p) => p.id);
    else if (body.outdated === true) ids = agentsWire(live, deps).outdated.map((o) => o.id);
    else if (Array.isArray(body.ids) && body.ids.length > 0 && body.ids.every((i) => typeof i === 'string')) {
      ids = body.ids as string[];
      const running = new Set(live.map((p) => p.id));
      const notRunning = ids.filter((id) => !running.has(id));
      if (notRunning.length === ids.length) return c.json({ error: 'its agent is not running in the PTY host' }, 409);
      ids = ids.filter((id) => running.has(id));
    } else return c.json({ error: 'say which: ids, outdated or all' }, 400);
    return c.json((await deps.restarter.request(ids)) satisfies RestartWire);
  });
}
