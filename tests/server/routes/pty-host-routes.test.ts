import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountPtyHostRoutes, type PtyHostRouteDeps } from '../../../src/server/routes/pty-host-routes.js';
import type { HostHealth } from '../../../src/core/pty/host-health.js';
import type { PtyHostRestartWire } from '../../../src/core/api-types.js';

const healthy: HostHealth = { state: 'ok', latencyMs: 5, quietMs: 0, error: null, outdated: null };
const outdated: HostHealth = { ...healthy, outdated: '2.8.0' };

function setup(over: Partial<PtyHostRouteDeps> = {}) {
  let now = outdated;
  const broadcast = vi.fn();
  const restart = vi.fn(async () => {
    now = healthy; // the new host is this work's release
    return { outcome: 'stopped' as const, pid: 77 };
  });
  const app = new Hono();
  mountPtyHostRoutes(app, { dev: false, health: () => now, restart, broadcast, ...over });
  const post = () => app.request('/api/pty-host/restart', { method: 'POST' });
  return { app, post, restart, broadcast };
}

describe('GET /api/pty-host/health', () => {
  it('serves what host-health reads, the outdated release included', async () => {
    const { app } = setup();
    expect(await (await app.request('/api/pty-host/health')).json()).toEqual(outdated);
  });
});

describe('POST /api/pty-host/restart (the banner button)', () => {
  it('restarts it, answers the new pid, and tells every window how the new host is', async () => {
    const { post, restart, broadcast } = setup();
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()) as PtyHostRestartWire).toEqual({ outcome: 'stopped', pid: 77 });
    expect(restart).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('host-health', healthy);
  });

  it('none was running: starts one, which counts as restarted', async () => {
    const { post } = setup({ restart: async () => ({ outcome: 'not-running', pid: 5 }) });
    expect(await (await post()).json()).toEqual({ outcome: 'not-running', pid: 5 });
  });

  it("a hung host that doesn't prove to be ours: 409 saying nothing was stopped, nothing broadcast", async () => {
    const { post, broadcast } = setup({ restart: async () => ({ outcome: 'unresponsive', pid: null }) });
    const res = await post();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('nothing was stopped');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('a kill that failed, or a start that threw: 409 with the reason', async () => {
    expect((await setup({ restart: async () => ({ outcome: 'failed', pid: null }) }).post()).status).toBe(409);
    const res = await setup({ restart: () => Promise.reject(new Error('spawn EACCES')) }).post();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("couldn't stop it (spawn EACCES)");
  });

  it('the dev server refuses, and restarts nothing (the installed work owns the host)', async () => {
    const { post, restart } = setup({ dev: true });
    expect((await post()).status).toBe(409);
    expect(restart).not.toHaveBeenCalled();
  });
});
