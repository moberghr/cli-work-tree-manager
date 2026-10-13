import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountAgentRestartRoutes, type AgentRestartDeps } from '../../../src/server/routes/agent-restart-routes.js';
import { createRestarter } from '../../../src/core/pty/agent-restart.js';
import type { PtyInfo } from '../../../src/core/pty/pty-host-protocol.js';
import type { AgentsWire, RestartWire } from '../../../src/core/api-types.js';

const pty = (id: string, startedAt: string, tool = 'claude'): PtyInfo => ({
  id,
  cwd: '/wt',
  pid: 1,
  exited: false,
  cols: 80,
  rows: 24,
  startedAt,
  restored: false,
  tool,
});

function setup(lookOnly?: string) {
  const restarted: string[] = [];
  const busy = new Set(['b']);
  const ptys = [pty('a', '2026-10-08T09:00:00Z'), pty('b', '2026-10-08T09:00:00Z'), pty('c', '2026-10-12T09:00:00Z')];
  const restarter = createRestarter({
    restart: async (id) => void restarted.push(id),
    busy: (id) => busy.has(id),
    running: (id) => ptys.some((p) => p.id === id),
  });
  const deps: AgentRestartDeps = {
    list: async () => ptys,
    installedAt: (tool) => (tool === 'claude' ? Date.parse('2026-10-11T11:12:00Z') : null),
    busy: (id) => busy.has(id),
    restarter,
  };
  const app = new Hono();
  mountAgentRestartRoutes(app, { deps, lookOnly });
  const post = (body: unknown) =>
    app.request('/api/agents/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { app, post, restarted };
}

describe('GET /api/agents', () => {
  it('lists the ones running a version from before their tool updated, which are busy, and when it updated', async () => {
    const { app } = setup();
    const w = (await (await app.request('/api/agents')).json()) as AgentsWire;
    expect(w.installedAt).toBe('2026-10-11T11:12:00.000Z');
    expect(w.outdated.map((o) => [o.id, o.busy])).toEqual([
      ['a', false],
      ['b', true],
    ]);
    expect(w.queued).toEqual([]);
  });
});

describe('POST /api/agents/restart', () => {
  it('outdated: restarts the idle one now, the busy one after its turn (then listed as queued)', async () => {
    const { app, post, restarted } = setup();
    const r = (await (await post({ outdated: true })).json()) as RestartWire;
    expect(r).toEqual({ now: ['a'], later: ['b'], failed: [] });
    expect(restarted).toEqual(['a']);
    expect(((await (await app.request('/api/agents')).json()) as AgentsWire).queued).toEqual(['b']);
  });

  it('ids and all; one not running is refused; a body that says nothing is a 400', async () => {
    const { post, restarted } = setup();
    expect(((await (await post({ ids: ['c', 'zzz'] })).json()) as RestartWire).now).toEqual(['c']);
    expect((await post({ ids: ['zzz'] })).status).toBe(409);
    expect((await post({})).status).toBe(400);
    expect((await post({ ids: [1] })).status).toBe(400);
    expect(((await (await post({ all: true })).json()) as RestartWire).now).toEqual(['a', 'c']);
    expect(restarted).toEqual(['c', 'a', 'c']);
  });

  it('the dev server restarts nothing, and says why', async () => {
    const { post, restarted } = setup('the dev server restarts nothing');
    const res = await post({ outdated: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('the dev server restarts nothing');
    expect(restarted).toEqual([]);
  });
});
