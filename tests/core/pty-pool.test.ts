import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- fakes for the pool's collaborators -----------------------------------

const sessions: Record<string, { paths: string[]; isGroup?: boolean; port?: number; archivedAt?: string }> = {
  single: { paths: [path.resolve('/wt/api/feat-x')], port: 4100 },
  archived: { paths: [path.resolve('/wt/api/old')], archivedAt: '2026-10-01T10:33:03Z' },
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
/** The patient variant: what the real one returns after waiting. */
const findHostPatient = vi.fn(async () => findHost());
class PtyHostVersionError extends Error {}

vi.mock('../../src/core/web-state.js', () => ({
  findSession: (id: string) => sessions[id] ?? null,
  sessionIdFor: (x: { target: string; branch: string }) => `${x.target}:${x.branch}`,
}));
vi.mock('../../src/core/config.js', () => ({ loadConfig: () => ({}), getConfigDir: () => os.tmpdir() }));
vi.mock('../../src/core/ai-launcher.js', () => ({ getAiTool: (c?: { aiCommand?: string }) => ({ cmd: (c?.aiCommand ?? 'claude').split(' ')[0], baseArgs: [] }) }));
vi.mock('../../src/core/pty-host-client.js', () => ({
  ensureHost: (...a: unknown[]) => ensureHost(...(a as [])),
  findHost: (...a: unknown[]) => findHost(...(a as [])),
  findHostPatient: (...a: unknown[]) => findHostPatient(...(a as [])),
  PtyHostVersionError,
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
vi.mock('../../src/core/pty-host-protocol.js', () => ({
  hostStartLockPath: () => sessionsFile + '.start.lock',
}));
// The host's restore list (state.db in real life), in memory here.
const restore = vi.hoisted(() => ({ list: {} as Record<string, unknown> }));
vi.mock('../../src/core/pty-sessions-file.js', () => ({
  dbPtySessions: {
    read: () => restore.list,
    write: (all: Record<string, unknown>) => void (restore.list = all),
  },
  forgetPersistedSession: async (id: string) => void delete restore.list[id],
}));

async function freshPool() {
  vi.resetModules();
  return import('../../src/core/pty-pool.js');
}

beforeEach(() => {
  host.spawned = []; host.killed = []; host.written = []; host.live = new Set(); host.failNextSpawn = false;
  hostRunning = false;
  ensureHost.mockClear(); findHost.mockClear(); findHostPatient.mockClear(); findHostPatient.mockImplementation(async () => findHost());
  sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-pool-')), 'pty-sessions.json');
  restore.list = {};
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

  it('runs the agent the session was created with, not whatever the default is now', async () => {
    const pool = await freshPool();
    expect(pool.spawnSpecFor(sessions.single as never)?.tool.cmd).toBe('claude');
    expect(pool.spawnSpecFor({ ...sessions.single, agent: 'opencode' } as never)?.tool.cmd).toBe('opencode');
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

  it('the dashboard assistant spawns in its own folder, written first — not a worktree', async () => {
    const pool = await freshPool();
    expect(await pool.ensurePty('assistant')).toBe('ws://host/assistant');
    const spec = host.spawned.find((s) => s.id === 'assistant')!.spec as { cwd: string; unsafe?: boolean };
    const { assistantDir } = await import('../../src/core/assistant.js');
    expect(spec.cwd).toBe(assistantDir());
    expect(spec.unsafe).toBeFalsy(); // normal permission mode, always
    expect(fs.existsSync(path.join(spec.cwd, '.claude', 'settings.json'))).toBe(true);
  });

  it('passes a first prompt to the spawn (a session started from a ticket)', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single', { initialPrompt: 'Work on ABC-1' });
    expect(host.spawned[0].spec).toMatchObject({ cwd: sessions.single.paths[0], initialPrompt: 'Work on ABC-1' });
  });

  it("never starts an archived session's Claude, or one being archived (a Terminal tab still open on it reconnects)", async () => {
    const pool = await freshPool();
    await expect(pool.ensurePty('archived')).rejects.toThrow(/archived\. Restore it/);
    const { whileArchiving } = await import('../../src/core/archiving.js');
    let during: unknown;
    await whileArchiving('single', async () => {
      during = await pool.ensurePty('single').catch((e: Error) => e.message);
    });
    expect(during).toBe('This session is being archived.');
    expect(host.spawned).toEqual([]);
    expect(await pool.ensurePty('single')).toBe('ws://host/single'); // after: as before
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

  it('disposePty with no cached client finds the host (waiting out a busy one) and kills', async () => {
    hostRunning = true;
    const pool = await freshPool();
    await pool.disposePty('single');
    expect(findHostPatient).toHaveBeenCalled();
    expect(host.killed).toEqual(['single']);
  });

  it('disposePty reports a host that stays busy instead of silently skipping the kill', async () => {
    const pool = await freshPool();
    findHostPatient.mockRejectedValueOnce(new Error('The PTY host is running but not answering (busy?).'));
    await expect(pool.disposePty('single')).rejects.toThrow(/busy/);
    expect(host.killed).toEqual([]);
  });

  it('disposePty leaves a host from another build alone', async () => {
    const pool = await freshPool();
    findHostPatient.mockRejectedValueOnce(new PtyHostVersionError('old'));
    await pool.disposePty('single');
    expect(host.killed).toEqual([]);
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
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('starts the host (which restores) when sessions were live last time', async () => {
    restore.list = { a: {}, b: {} };
    const pool = await freshPool();
    expect(await pool.resumePersistedSessions()).toBe(2);
    expect(ensureHost).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-running host alone', async () => {
    restore.list = { a: {} };
    hostRunning = true;
    const pool = await freshPool();
    expect(await pool.resumePersistedSessions()).toBe(0);
    expect(ensureHost).not.toHaveBeenCalled();
  });
});

describe('stopSessionPty (CLI removal)', () => {
  it('with a host running: kills the session there', async () => {
    hostRunning = true;
    const pool = await freshPool();
    await pool.stopSessionPty('api', 'feat/x');
    expect(host.killed).toHaveLength(1);
  });

  it('with no host: drops it from the saved list so a later host start does not restore it (reviewed race)', async () => {
    const pool = await freshPool();
    const id = 'api:feat/x'; // the mocked sessionIdFor
    restore.list = { [id]: { cwd: '/x' }, other: { cwd: '/y' } };
    await pool.stopSessionPty('api', 'feat/x');
    expect(restore.list).toEqual({ other: { cwd: '/y' } });
    expect(ensureHost).not.toHaveBeenCalled(); // never starts a host
  });
});
