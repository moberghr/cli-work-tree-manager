import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountSessionProcessRoutes } from '../../../src/server/routes/session-process-routes.js';
import { saveHistory, type WorktreeSession } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/web-state.js';
import type { ProcessUsage } from '../../../src/core/platform/process-usage.js';
import type { SessionProcessesWire } from '../../../src/core/api-types.js';

/** GET /api/sessions/:id/processes and its stop: what a session holds, and stopping one left running. */
const NOW = Date.parse('2026-11-16T12:00:00Z');
const MB = 1024 * 1024;
let home: string;
let wt: string;
let id: string;
let procs: ProcessUsage[];
let killed: number[];
let lists: number;
let clock: number;

const p = (pid: number, ppid: number, command: string, mb: number, agoH: number): ProcessUsage => ({
  pid,
  ppid,
  name: command.split(' ')[0],
  exe: null,
  command,
  memBytes: mb * MB,
  startedAt: NOW - agoH * 3_600_000,
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'work-procs-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  wt = path.join(home, 'wt');
  const session: WorktreeSession = { target: 'api', branch: 'feat/x', isGroup: false, paths: [wt], createdAt: 'x', lastAccessedAt: 'x' };
  saveHistory([session]);
  id = sessionIdFor(session);
  procs = [p(100, 1, 'claude --continue', 760, 60), p(111, 100, 'node vite.js', 1340, 50), p(400, 1, 'node other.js', 900, 5)];
  killed = [];
  lists = 0;
  clock = NOW;
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

function app(over: { agentPid?: number | null; kill?: (pid: number) => Promise<boolean> } = {}) {
  const a = new Hono();
  mountSessionProcessRoutes(a, {
    list: async () => (lists++, procs),
    agentPid: () => (over.agentPid === undefined ? 100 : over.agentPid),
    kill: over.kill ?? (async (pid) => (killed.push(pid), (procs = procs.filter((x) => x.pid !== pid)), true)),
    now: () => clock,
  });
  return a;
}
const stop = (a: Hono, body: unknown, session = id) =>
  a.request(`/api/sessions/${session}/processes/stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('session process routes', () => {
  it('GET lists the session’s own: its agent and what it started, most memory first, with the total', async () => {
    const res = await app().request(`/api/sessions/${id}/processes`);
    expect(res.status).toBe(200);
    const w = (await res.json()) as SessionProcessesWire;
    expect(w.processes.map((x) => [x.pid, x.agent ?? false, x.leftover ?? false])).toEqual([
      [111, false, true],
      [100, true, false],
    ]);
    expect(w.totalBytes).toBe(2100 * MB);
    expect(w.leftovers).toBe(1);
  });

  it('one listing serves the requests of the next few seconds (it takes a second on Windows); then it is read again', async () => {
    const a = app();
    await a.request(`/api/sessions/${id}/processes`);
    await a.request(`/api/sessions/${id}/processes`);
    expect(lists).toBe(1);
    clock += 5_000;
    await a.request(`/api/sessions/${id}/processes`);
    expect(lists).toBe(2);
  });

  it('an unknown session is 404; processes that can’t be read are said so, never "nothing runs"', async () => {
    expect((await app().request('/api/sessions/nope/processes')).status).toBe(404);
    procs = [];
    const res = await app().request(`/api/sessions/${id}/processes`);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "couldn't read the running processes" });
  });

  it('stop: looks again, stops that process, and answers what is left', async () => {
    const a = app();
    await a.request(`/api/sessions/${id}/processes`);
    const res = await stop(a, { pid: 111, startedAt: procs[1].startedAt });
    expect(res.status).toBe(200);
    expect(killed).toEqual([111]);
    expect(((await res.json()) as SessionProcessesWire).processes.map((x) => x.pid)).toEqual([100]);
    // Read fresh for the check and again after, whatever was kept.
    expect(lists).toBe(3);
  });

  it('stop refuses the agent, another session’s process, a reused pid and a bad request — and kills nothing', async () => {
    const a = app();
    expect((await stop(a, { pid: 100, startedAt: procs[0].startedAt })).status).toBe(409);
    expect((await stop(a, { pid: 400, startedAt: procs[2].startedAt })).status).toBe(409);
    const reused = await stop(a, { pid: 111, startedAt: procs[1].startedAt! + 3_600_000 });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: 'Not stopped: the process under that number is not the one that was listed.' });
    expect((await stop(a, { pid: 111 })).status).toBe(409); // no start time: can't be told from a reused pid
    expect((await stop(a, { pid: 'x' })).status).toBe(400);
    expect((await stop(a, { pid: 111, startedAt: 1 }, 'nope')).status).toBe(404);
    expect(killed).toEqual([]);
  });

  it('a stop that fails says so', async () => {
    const res = await stop(app({ kill: async () => false }), { pid: 111, startedAt: procs[1].startedAt });
    expect(res.status).toBe(500);
  });
});
