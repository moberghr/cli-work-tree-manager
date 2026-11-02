import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

// The real deps over faked collaborators: the live agents (every account's), the PTY host's pids, the history.
const live = vi.hoisted(() => ({
  agents: [] as Array<{ pid: number; cwd: string }>,
  ownPid: null as number | null,
  hostPids: new Set<number>(),
  bySession: new Map<string, Array<{ pid: number }>>(),
  withAccounts: true,
}));
const pool = vi.hoisted(() => ({
  accountSwitchRefusal: async () => 'old host',
  peekPty: () => true,
  ptyPid: () => live.ownPid,
  ptyPids: () => live.hostPids,
  haltPty: vi.fn(async () => 'halted' as const),
  resumePtyOnAccount: vi.fn(async () => undefined),
}));
const switchFiles = vi.hoisted(() => vi.fn(async () => ({ moved: ['x'] })));
vi.mock('../../../src/core/agents/index.js', () => ({
  agentOf: () => ({
    accounts: live.withAccounts
      ? {
          list: () => [],
          current: () => 'default',
          switchFiles,
          folders: (s: { paths: string[] }) => s.paths,
        }
      : undefined,
  }),
  liveAgents: () => live.agents,
}));
vi.mock('../../../src/core/pty/pty-pool.js', () => pool);
const history = vi.hoisted(() => ({ setSessionAccount: vi.fn(async () => true), loadHistory: () => [] }));
vi.mock('../../../src/core/sessions/history.js', () => history);
vi.mock('../../../src/core/sessions/live-agents.js', () => ({ agentsBySession: () => live.bySession }));

const { defaultAccountSwitchDeps } = await import('../../../src/core/sessions/account-switch-deps.js');

const folder = path.resolve('/wt/api/feat-x');
const s = { target: 'api', branch: 'feat/x', isGroup: false, paths: [folder], createdAt: '', lastAccessedAt: '' } as WorktreeSession;

describe('defaultAccountSwitchDeps', () => {
  const deps = defaultAccountSwitchDeps({ busy: () => false });

  it("othersRunningIn: a live agent in one of its folders that isn't its own PTY's", () => {
    live.ownPid = 10;
    live.agents = [{ pid: 10, cwd: folder }];
    expect(deps.othersRunningIn!(s, 'api:feat/x')).toBeNull();
    live.agents.push({ pid: 11, cwd: path.resolve('/elsewhere') });
    expect(deps.othersRunningIn!(s, 'api:feat/x')).toBeNull();
    live.agents.push({ pid: 12, cwd: folder + path.sep });
    expect(deps.othersRunningIn!(s, 'api:feat/x')).toBe(folder);
    // Not in the host: any Claude there is another.
    live.ownPid = null;
    live.agents = [{ pid: 10, cwd: process.platform === 'win32' ? folder.toUpperCase() : folder }];
    expect(deps.othersRunningIn!(s, 'api:feat/x')).toBe(folder);
  });

  it("hostRefusal is the pool's", async () => {
    expect(await deps.hostRefusal!()).toBe('old host');
  });

  it('runningOutside: one of its agents whose pid the PTY host does not own; none, or only the host’s, is not (T3)', () => {
    live.bySession = new Map();
    expect(deps.runningOutside('api:feat/x')).toBe(false);
    live.hostPids = new Set([20]);
    live.bySession = new Map([['api:feat/x', [{ pid: 20 }]]]);
    expect(deps.runningOutside('api:feat/x')).toBe(false);
    live.bySession = new Map([['api:feat/x', [{ pid: 20 }, { pid: 21 }]]]);
    expect(deps.runningOutside('api:feat/x')).toBe(true);
    expect(deps.runningOutside('other')).toBe(false);
  });

  it('record writes the account through history, and throws for a session that is gone (T3)', async () => {
    await deps.record(s, 'work');
    expect(history.setSessionAccount).toHaveBeenCalledWith('api', 'feat/x', 'work');
    history.setSessionAccount.mockResolvedValueOnce(false);
    await expect(deps.record(s, 'work')).rejects.toThrow('unknown session');
  });

  it('halt and resume are the pool’s, hostRuns is peekPty (T3)', () => {
    expect(deps.halt).toBe(pool.haltPty);
    expect(deps.resume).toBe(pool.resumePtyOnAccount);
    expect(deps.hostRuns).toBe(pool.peekPty);
  });

  it('switchFiles is the agent’s; an agent without accounts throws, and accounts() says none (T3)', async () => {
    expect(await deps.switchFiles(s, 'work')).toEqual({ moved: ['x'] });
    expect(switchFiles).toHaveBeenCalledWith(s, 'work');
    live.withAccounts = false;
    try {
      expect(() => deps.switchFiles(s, 'work')).toThrow('its agent has no accounts');
      expect(deps.accounts(s)).toBeNull();
      expect(deps.othersRunningIn!(s, 'api:feat/x')).toBeNull();
    } finally {
      live.withAccounts = true;
    }
  });
});
