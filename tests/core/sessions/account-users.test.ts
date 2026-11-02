import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgent, agentById, AccountAdminError, type AgentAccounts, type AgentAdapter } from '../../../src/core/agents/index.js';
import { removeAgentAccount, sessionsOnAccount } from '../../../src/core/sessions/account-users.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/** Which sessions are on an account, and removing one (account-users.ts): agent-neutral, through the adapter's accounts part. */

const row = (target: string, o: { agent?: string; account?: string; archivedAt?: string } = {}) =>
  ({ target, branch: 'feat/x', isGroup: false, paths: ['/p'], createdAt: '', lastAccessedAt: '', ...o }) as WorktreeSession;

function echoAgent(remove = vi.fn(async (_n: string, usedBy: () => { live: string[]; archived: string[] }) => void usedBy())) {
  const accounts: AgentAccounts = {
    list: () => [],
    defaultName: () => 'home',
    has: () => true,
    current: (s) => s.account || 'home',
    switchFiles: async () => ({ moved: [] }),
    folders: () => [],
    admin: {
      add: async () => '',
      setDefault: async () => {},
      remove,
      login: () => {},
      installSkills: () => ({ ok: true, message: '' }),
    },
  };
  const adapter: AgentAdapter = { ...agentById('echo'), id: 'echo', name: 'Echo', accounts };
  return { adapter, accounts, remove };
}

let unregister: (() => void) | null = null;
afterEach(() => {
  unregister?.();
  unregister = null;
});

describe('sessionsOnAccount', () => {
  it("counts a session by its own agent's word for its account: live and archived apart, other agents' never", () => {
    const { adapter, accounts } = echoAgent();
    unregister = registerAgent(adapter);
    const sessions = [
      row('a', { agent: 'echo', account: 'spare' }),
      row('b', { agent: 'echo', account: 'spare', archivedAt: '2026-10-01' }),
      row('c', { agent: 'echo' }), // its agent's default ('home')
      row('d', { agent: 'claude', account: 'spare' }), // another agent's account of the same name
    ];
    expect(sessionsOnAccount('spare', accounts, sessions)).toEqual({ live: ['a · feat/x'], archived: ['b · feat/x'] });
    expect(sessionsOnAccount('home', accounts, sessions)).toEqual({ live: ['c · feat/x'], archived: [] });
  });
});

describe('removeAgentAccount', () => {
  it('hands the admin who uses it — archived ones dropped when forced, live ones never', async () => {
    const { adapter, accounts, remove } = echoAgent();
    unregister = registerAgent(adapter);
    const sessions = () => [row('a', { agent: 'echo', account: 'spare' }), row('b', { agent: 'echo', account: 'spare', archivedAt: 'x' })];
    const seen: Array<{ live: string[]; archived: string[] }> = [];
    remove.mockImplementation(async (_n, usedBy) => void seen.push(usedBy()));
    await removeAgentAccount(accounts, 'spare', { sessions });
    await removeAgentAccount(accounts, 'spare', { sessions, force: true });
    expect(seen).toEqual([
      { live: ['a · feat/x'], archived: ['b · feat/x'] },
      { live: ['a · feat/x'], archived: [] },
    ]);
  });

  it('an agent whose accounts work does not manage is refused', async () => {
    const { accounts } = echoAgent();
    await expect(removeAgentAccount({ ...accounts, admin: undefined }, 'spare', { sessions: () => [] })).rejects.toBeInstanceOf(
      AccountAdminError,
    );
  });
});
