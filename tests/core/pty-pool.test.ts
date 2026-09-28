import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- fakes for the pool's collaborators -----------------------------------

const sessions: Record<string, { paths: string[]; isGroup?: boolean; port?: number }> = {
  single: { paths: [path.resolve('/wt/api/feat-x')], port: 4100 },
  group: { paths: [path.resolve('/wt/shop/feat-y/backend'), path.resolve('/wt/shop/feat-y/frontend')], isGroup: true },
};

const host = {
  spawned: [] as Array<{ id: string; spec: { cwd: string; port?: number } }>,
  killed: [] as string[],
  written: [] as Array<[string, string]>,
  live: new Set<string>(),
  failNextSpawn: false,
};
let hostRunning = false;
const ensureHost = vi.fn(async () => { hostRunning = true; return { pid: 1, port: 9, token: 't', version: 1 }; });
const findHost = vi.fn(async () => (hostRunning ? { pid: 1, port: 9, token: 't', version: 1 } : null));

vi.mock('../../src/core/web-state.js', () => ({ findSession: (id: string) => sessions[id] ?? null }));
vi.mock('../../src/core/config.js', () => ({ loadConfig: () => ({}), getConfigDir: () => os.tmpdir() }));
vi.mock('../../src/core/ai-launcher.js', () => ({ getAiTool: () => ({ cmd: 'claude', baseArgs: [] }) }));
vi.mock('../../src/core/pty-host-client.js', () => ({
  ensureHost: (...a: unknown[]) => ensureHost(...(a as [])),
  findHost: (...a: unknown[]) => findHost(...(a as [])),
  PtyHostClient: class {
    async spawn(id: string, spec: { cwd: string; port?: number }) {
      if (host.failNextSpawn) { host.failNextSpawn = false; throw new Error('ECONNREFUSED'); }
      host.spawned.push({ id, spec });
      host.live.add(id);
      return {};
    }
    async list() { return [...host.live].map((id) => ({ id, exited: false })); }
    async write(id: string, data: string) { host.written.push([id, data]); return true; }
    async kill(id: string) { host.killed.push(id); host.live.delete(id); }
    attachUrl(id: string) { return `ws://host/${id}`; }
  },
}));

let sessionsFile: string;
vi.mock('../../src/core/pty-host-protocol.js', () => ({ ptySessionsPath: () => sessionsFile }));

async function freshPool() {
  vi.resetModules();
  return import('../../src/core/pty-pool.js');
}

beforeEach(() => {
  host.spawned = []; host.killed = []; host.written = []; host.live = new Set(); host.failNextSpawn = false;
  hostRunning = false;
  ensureHost.mockClear(); findHost.mockClear();
  sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-pool-')), 'pty-sessions.json');
});
afterEach(async () => {
  (await import('../../src/core/pty-pool.js')).detachPtyPool();
});

describe('spawnSpecFor', () => {
  it('launches a single repo in its worktree and a group in the group root', async () => {
    const pool = await freshPool();
    expect(pool.spawnSpecFor(sessions.single as never)?.cwd).toBe(sessions.single.paths[0]);
    expect(pool.spawnSpecFor(sessions.single as never)?.port).toBe(4100);
    expect(pool.spawnSpecFor(sessions.group as never)?.cwd).toBe(path.resolve('/wt/shop/feat-y'));
    expect(pool.spawnSpecFor({ paths: [] } as never)).toBeNull();
  });
});

describe('ensurePty', () => {
  it('returns null for an unknown session without starting a host', async () => {
    const pool = await freshPool();
    expect(await pool.ensurePty('nope')).toBeNull();
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('starts the host on demand, spawns, and reports the session live', async () => {
    const pool = await freshPool();
    expect(await pool.ensurePty('single')).toBe('ws://host/single');
    expect(ensureHost).toHaveBeenCalledTimes(1);
    expect(host.spawned[0]).toMatchObject({ id: 'single', spec: { cwd: sessions.single.paths[0] } });
    expect(pool.peekPty('single')).toBe(true);
  });

  it('retries once with a fresh host connection when the cached one is stale', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    host.failNextSpawn = true;
    expect(await pool.ensurePty('group')).toBe('ws://host/group');
    expect(ensureHost).toHaveBeenCalledTimes(2);
  });
});

describe('writeToPty / disposePty / detach', () => {
  it('never writes to (or spawns) a session with no live PTY', async () => {
    const pool = await freshPool();
    expect(await pool.writeToPty('single', 'hi')).toBe(false);
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('writes to a live PTY and kills it on dispose', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    expect(await pool.writeToPty('single', 'hi')).toBe(true);
    expect(host.written).toEqual([['single', 'hi']]);
    await pool.disposePty('single');
    expect(host.killed).toEqual(['single']);
    expect(pool.peekPty('single')).toBe(false);
  });

  it('detaching (work web shutdown) kills nothing', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    pool.detachPtyPool();
    expect(host.killed).toEqual([]);
  });
});

describe('resumePersistedSessions', () => {
  it('does nothing without a saved session list', async () => {
    const pool = await freshPool();
    expect(await pool.resumePersistedSessions()).toBe(0);
    fs.writeFileSync(sessionsFile, '{}');
    expect(await pool.resumePersistedSessions()).toBe(0);
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('starts the host (which restores) when sessions were live last time', async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ a: {}, b: {} }));
    const pool = await freshPool();
    expect(await pool.resumePersistedSessions()).toBe(2);
    expect(ensureHost).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-running host alone', async () => {
    fs.writeFileSync(sessionsFile, JSON.stringify({ a: {} }));
    hostRunning = true;
    const pool = await freshPool();
    expect(await pool.resumePersistedSessions()).toBe(0);
    expect(ensureHost).not.toHaveBeenCalled();
  });
});
