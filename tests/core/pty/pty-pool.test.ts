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
  restarted: [] as string[],
  /** The environment each restart carried (a session moved to another account). */
  restartEnv: [] as unknown[],
  /** What the host answers halt / resume (a host from before: `unsupported` for halt). */
  haltAnswer: 'halted' as 'halted' | 'not-running' | 'unsupported',
  resumeAnswer: 'resumed' as 'resumed' | 'not-halted',
  halted: [] as string[],
  resumed: [] as Array<[string, unknown]>,
  /** What the host answers a restart: a host from before the call says `unsupported` (404). */
  restartAnswer: 'restarted' as 'restarted' | 'not-running' | 'unsupported',
  /** The cached client's host moved (restarted on a new port): the first call fails. */
  restartFailsOnce: false,
  /** What `/health` says it supports: [] = a host from before features; null = it couldn't be asked. */
  features: ['agentEnv', 'halt'] as string[] | null,
};
let hostRunning = false;
const ensureHost = vi.fn(async () => {
  hostRunning = true;
  return { pid: 1, port: 9, token: 't', version: 1 };
});
const findHost = vi.fn(async () => (hostRunning ? { pid: 1, port: 9, token: 't', version: 1 } : null));
/** The patient variant: what the real one returns after waiting. */
const findHostPatient = vi.fn(async () => findHost());
class PtyHostVersionError extends Error {}

vi.mock('../../../src/core/sessions/web-state.js', () => ({
  findSession: (id: string) => sessions[id] ?? null,
  sessionIdFor: (x: { target: string; branch: string }) => `${x.target}:${x.branch}`,
}));
const cfg = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
// The real module (agent settings read its path, isAgentId), with the config and its folder ours.
vi.mock('../../../src/core/platform/config.js', async (orig) => ({
  ...(await orig<object>()),
  loadConfig: () => cfg.value,
  getConfigDir: () => os.tmpdir(),
}));
// The cached raw config the per-row readers share (agent settings, Claude's accounts): the same config.
vi.mock('../../../src/core/platform/config-cache.js', () => ({
  configView:
    <T>(derive: (raw: Record<string, unknown> | null) => T) =>
    () =>
      derive(cfg.value),
}));
vi.mock('../../../src/core/platform/ai-launcher.js', () => ({
  getAiTool: (c?: { aiCommand?: string }) => ({ cmd: (c?.aiCommand ?? 'claude').split(' ')[0], baseArgs: [] }),
}));
vi.mock('../../../src/core/pty/pty-host-client.js', () => ({
  ensureHost: (...a: unknown[]) => ensureHost(...(a as [])),
  findHost: (...a: unknown[]) => findHost(...(a as [])),
  findHostPatient: (...a: unknown[]) => findHostPatient(...(a as [])),
  PtyHostVersionError,
  PtyHostClient: class {
    async spawn(id: string, spec: { cwd: string; port?: number }) {
      if (host.failNextSpawn) {
        host.failNextSpawn = false;
        throw new Error('ECONNREFUSED');
      }
      host.spawned.push({ id, spec });
      host.live.add(id);
      return {};
    }
    async list() {
      return [...host.live].map((id) => ({ id, exited: false }));
    }
    async write(id: string, data: string) {
      host.written.push([id, data]);
      return true;
    }
    async features() {
      return host.features;
    }
    async halt(id: string) {
      host.halted.push(id);
      return host.haltAnswer;
    }
    async resume(id: string, opts: { agentEnv?: unknown } = {}) {
      host.resumed.push([id, opts.agentEnv]);
      return host.resumeAnswer;
    }
    async restart(id: string, opts: { agentEnv?: unknown } = {}) {
      host.restartEnv.push(opts.agentEnv);
      if (host.restartFailsOnce) {
        host.restartFailsOnce = false;
        throw new Error('fetch failed');
      }
      host.restarted.push(id);
      return host.restartAnswer;
    }
    async kill(id: string) {
      host.killed.push(id);
      host.live.delete(id);
    }
    attachUrl(id: string) {
      return `ws://host/${id}`;
    }
  },
}));

let sessionsFile: string;
vi.mock('../../../src/core/pty/pty-host-protocol.js', () => ({
  hostStartLockPath: () => sessionsFile + '.start.lock',
}));
// The host's restore list (state.db in real life), in memory here.
const restore = vi.hoisted(() => ({ list: {} as Record<string, unknown> }));
vi.mock('../../../src/core/pty/pty-sessions-file.js', () => ({
  dbPtySessions: {
    read: () => restore.list,
    write: (all: Record<string, unknown>) => void (restore.list = all),
  },
  forgetPersistedSession: async (id: string) => void delete restore.list[id],
}));

async function freshPool() {
  vi.resetModules();
  return import('../../../src/core/pty/pty-pool.js');
}

beforeEach(() => {
  host.spawned = [];
  host.killed = [];
  host.written = [];
  host.live = new Set();
  host.failNextSpawn = false;
  host.restarted = [];
  host.restartEnv = [];
  host.haltAnswer = 'halted';
  host.resumeAnswer = 'resumed';
  host.halted = [];
  host.resumed = [];
  host.restartAnswer = 'restarted';
  host.features = ['agentEnv', 'halt'];
  hostRunning = false;
  ensureHost.mockClear();
  findHost.mockClear();
  findHostPatient.mockClear();
  findHostPatient.mockImplementation(async () => findHost());
  sessionsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pty-pool-')), 'pty-sessions.json');
  restore.list = {};
});
afterEach(async () => {
  (await import('../../../src/core/pty/pty-pool.js')).detachPtyPool();
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
    try {
      cfg.value = { aiCommand: 'opencode' };
      expect(pool.spawnSpecFor({ ...sessions.single, agent: 'claude' } as never)?.tool.cmd).toBe('claude'); // recorded
      expect(pool.spawnSpecFor(sessions.single as never)?.tool.cmd).toBe('opencode'); // from before: the default
    } finally {
      cfg.value = {};
    }
  });
});

describe("a session's Claude account in the spawn spec", () => {
  const work = path.resolve('/acc/work');
  afterEach(() => {
    cfg.value = {};
  });

  it('a named account sets CLAUDE_CONFIG_DIR; the default takes it out once accounts exist; no accounts: no change', async () => {
    const pool = await freshPool();
    expect(pool.spawnSpecFor(sessions.single as never)).not.toHaveProperty('agentEnv'); // no accounts: today's behaviour
    cfg.value = { claudeAccounts: { work } };
    expect(pool.spawnSpecFor({ ...sessions.single, account: 'work' } as never)?.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: work });
    expect(pool.spawnSpecFor({ ...sessions.single, account: 'default' } as never)?.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: null });
    expect(pool.spawnSpecFor(sessions.single as never)?.agentEnv).toEqual({ CLAUDE_CONFIG_DIR: null }); // a row from before
  });

  it('a session on another agent gets no Claude account env', async () => {
    const pool = await freshPool();
    cfg.value = { claudeAccounts: { work }, aiCommand: 'opencode' };
    expect(pool.spawnSpecFor({ ...sessions.single, account: 'work' } as never)).not.toHaveProperty('agentEnv');
  });

  it('the assistant runs on the configured default account', async () => {
    const pool = await freshPool();
    cfg.value = { claudeAccounts: { work }, claudeAccount: 'work' };
    expect(pool.assistantSpec().agentEnv).toEqual({ CLAUDE_CONFIG_DIR: work });
    cfg.value = { claudeAccounts: { work }, claudeAccount: 'default' };
    expect(pool.assistantSpec().agentEnv).toEqual({ CLAUDE_CONFIG_DIR: null });
  });

  it('ensurePty hands the host the account with the spec', async () => {
    const pool = await freshPool();
    cfg.value = { claudeAccounts: { work } };
    sessions.single = { ...sessions.single, account: 'work' } as never;
    try {
      await pool.ensurePty('single');
      expect(host.spawned.at(-1)?.spec).toMatchObject({ agentEnv: { CLAUDE_CONFIG_DIR: work } });
    } finally {
      delete (sessions.single as { account?: string }).account;
    }
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

  it("the dev server (startHost: false) uses the running host and never starts one from its checkout's build", async () => {
    const pool = await freshPool();
    pool.configurePtyPool({ workBin: '/checkout/dist/bin.js', startHost: false });
    // None running: nothing started, and it says why (not "unknown session").
    await expect(pool.ensurePty('single')).rejects.toThrow(/No PTY host is running, and the dev server doesn't start one/);
    expect(ensureHost).not.toHaveBeenCalled();
    hostRunning = true;
    expect(await pool.ensurePty('single')).toBe('ws://host/single'); // the running one is used
    expect(ensureHost).not.toHaveBeenCalled();
  });

  it('the dashboard assistant spawns in its own folder, written first — not a worktree', async () => {
    const pool = await freshPool();
    expect(await pool.ensurePty('assistant')).toBe('ws://host/assistant');
    const spec = host.spawned.find((s) => s.id === 'assistant')!.spec as { cwd: string; unsafe?: boolean };
    const { assistantDir } = await import('../../../src/core/agents/assistant.js');
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
    const { whileArchiving } = await import('../../../src/core/archive/archiving.js');
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

describe('restartPty', () => {
  it('restarts in place in the host; one from before the call is stopped and started again', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    host.spawned = [];
    await pool.restartPty('single');
    expect(host.restarted).toEqual(['single']);
    expect(host.killed).toEqual([]);
    host.restartAnswer = 'unsupported';
    await pool.restartPty('single');
    expect(host.killed).toEqual(['single']);
    expect(host.spawned.map((s) => s.id)).toEqual(['single']);
  });

  it('a host that moved since the last look is found again, once (as ensurePty does)', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    host.restartFailsOnce = true;
    await pool.restartPty('single');
    expect(host.restarted).toEqual(['single']);
  });

  it('says so when its agent is not running, or there is no host', async () => {
    const pool = await freshPool();
    await expect(pool.restartPty('single')).rejects.toThrow(/PTY host is not running/);
    await pool.ensurePty('single');
    host.restartAnswer = 'not-running';
    await expect(pool.restartPty('single')).rejects.toThrow(/not running in the PTY host/);
  });
});

describe('haltPty / resumePtyOnAccount', () => {
  const work = path.resolve('/acc/work');
  afterEach(() => {
    cfg.value = {};
    delete (sessions.single as { account?: string }).account;
  });

  it('halt keeps the session in the host; resume starts it in place with the environment of the account the session records now', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    expect(await pool.haltPty('single')).toBe('halted');
    expect(host.killed).toEqual([]);
    cfg.value = { claudeAccounts: { work } };
    (sessions.single as { account?: string }).account = 'work';
    await pool.resumePtyOnAccount('single', 'halted');
    expect(host.resumed).toEqual([['single', { CLAUDE_CONFIG_DIR: work }]]);
    // The old account again (a switch that failed): the variable is taken out, not left as it was.
    (sessions.single as { account?: string }).account = 'default';
    await pool.resumePtyOnAccount('single', 'halted');
    expect(host.resumed.at(-1)).toEqual(['single', { CLAUDE_CONFIG_DIR: null }]);
  });

  it('an older host (halt is a 404): stopped the old way, and resume starts it fresh from the new spec', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    host.haltAnswer = 'unsupported';
    expect(await pool.haltPty('single')).toBe('stopped');
    expect(host.killed).toEqual(['single']);
    cfg.value = { claudeAccounts: { work } };
    (sessions.single as { account?: string }).account = 'work';
    host.spawned = [];
    await pool.resumePtyOnAccount('single', 'stopped');
    expect(host.resumed).toEqual([]);
    expect((host.spawned[0].spec as { agentEnv?: unknown }).agentEnv).toEqual({ CLAUDE_CONFIG_DIR: work });
  });

  it('nothing running is gone; an unknown session is refused', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    host.haltAnswer = 'not-running';
    expect(await pool.haltPty('single')).toBe('gone');
    await expect(pool.resumePtyOnAccount('nope', 'halted')).rejects.toThrow(/unknown session/);
  });

  it("started again meanwhile (the host's own resume after HALT_RESUME_MS, a host restart): restarted in place on the new account, and said", async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    await pool.haltPty('single');
    cfg.value = { claudeAccounts: { work } };
    (sessions.single as { account?: string }).account = 'work';
    host.resumeAnswer = 'not-halted';
    expect(await pool.resumePtyOnAccount('single', 'halted')).toBe(pool.RESTARTED_AFTER_AUTO_RESUME);
    expect(host.restarted).toEqual(['single']);
    expect(host.restartEnv).toEqual([{ CLAUDE_CONFIG_DIR: work }]);
    expect(host.killed).toEqual([]);
  });

  it('not running by then: started fresh on the new spec; a host that could not restart in place: stopped and started', async () => {
    const pool = await freshPool();
    await pool.ensurePty('single');
    cfg.value = { claudeAccounts: { work } };
    (sessions.single as { account?: string }).account = 'work';
    host.resumeAnswer = 'not-halted';
    host.restartAnswer = 'not-running';
    host.spawned = [];
    expect(await pool.resumePtyOnAccount('single', 'halted')).toBe(pool.RESTARTED_AFTER_AUTO_RESUME);
    expect(host.killed).toEqual([]);
    expect((host.spawned[0].spec as { agentEnv?: unknown }).agentEnv).toEqual({ CLAUDE_CONFIG_DIR: work });
    host.restartAnswer = 'unsupported';
    host.spawned = [];
    await pool.resumePtyOnAccount('single', 'halted');
    expect(host.killed).toEqual(['single']);
    expect(host.spawned).toHaveLength(1);
  });
});

describe('a PTY host from before accounts (review W4)', () => {
  const work = path.resolve('/acc/work');
  afterEach(() => {
    cfg.value = {};
    delete (sessions.single as { account?: string }).account;
  });

  it("a session on a named account is not started there (it would run on the host's account), with the way out", async () => {
    const pool = await freshPool();
    hostRunning = true;
    host.features = [];
    cfg.value = { claudeAccounts: { work } };
    (sessions.single as { account?: string }).account = 'work';
    await expect(pool.ensurePty('single')).rejects.toThrow(pool.OLD_HOST_ACCOUNTS);
    expect(pool.OLD_HOST_ACCOUNTS).toContain('work pty-host --restart');
    expect(host.spawned).toEqual([]);
    // A default session (the variable only taken out) still starts; one already running there is only attached to.
    await pool.ensurePty('group');
    expect(host.spawned.map((x) => x.id)).toEqual(['group']);
    host.live.add('single');
    await pool.ensurePty('single');
    expect(host.spawned.map((x) => x.id)).toEqual(['group', 'single']);
  });

  it('a switch asks first (refused on such a host, allowed when it says it takes agentEnv or cannot be asked)', async () => {
    const pool = await freshPool();
    expect(await pool.accountSwitchRefusal()).toBeNull(); // no host
    hostRunning = true;
    host.features = [];
    expect(await pool.accountSwitchRefusal()).toBe(pool.OLD_HOST_ACCOUNTS);
    host.features = ['agentEnv', 'halt'];
    expect(await pool.accountSwitchRefusal()).toBeNull();
    host.features = null;
    expect(await pool.accountSwitchRefusal()).toBeNull();
  });

  it('a resume carrying an environment is refused there, nothing sent', async () => {
    const pool = await freshPool();
    hostRunning = true;
    host.features = [];
    await expect(pool.resumePty('single', { agentEnv: { CLAUDE_CONFIG_DIR: work } })).rejects.toThrow(pool.OLD_HOST_ACCOUNTS);
    expect(host.resumed).toEqual([]);
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
