import { describe, expect, it, vi } from 'vitest';
import { agentsOnOldHooks, settleAgentHooks } from '../../../src/core/agents/hook-migration.js';
import type { AgentAdapter, LiveAgent } from '../../../src/core/agents/types.js';

/**
 * Moving work's hooks out of the user's settings without a running session missing a turn: they stay (bridged) while
 * a session's agent started before the update runs, and go once none does.
 */
const live = (pid: number, cwd: string, startedAt: number | null): LiveAgent => ({
  pid,
  conversationId: `c${pid}`,
  cwd,
  busy: false,
  state: 'idle',
  stateAt: null,
  waitingFor: null,
  startedAt,
});
const SINCE = 1_000;
const withHooks = (cmd: string) => cmd.includes('claude-settings.json');

describe('agentsOnOldHooks', () => {
  const commands = new Map([
    [1, 'claude --continue'], // started by an older work: no hooks of its own
    [2, 'claude --settings /h/.work/claude-settings.json --continue'], // started with them
  ]);
  const base = {
    commandOf: (pid: number) => commands.get(pid),
    inSession: (cwd: string) => cwd.startsWith('/wt/'),
    since: SINCE,
    startedWithSessionHooks: withHooks,
  };

  it('a session’s agent started before this work web, without work’s hooks, is on the old ones', () => {
    expect(agentsOnOldHooks({ ...base, running: [live(1, '/wt/a', 500)] }).map((a) => a.pid)).toEqual([1]);
  });

  it('one started with work’s hooks, one outside any session, and one started since (by this build, or by hand) are not', () => {
    const running = [live(2, '/wt/a', 500), live(1, '/home/other-project', 500), live(1, '/wt/b', 1_500)];
    expect(agentsOnOldHooks({ ...base, running })).toEqual([]);
  });

  it('a PTY host’s Claude started since without work’s hooks is old (an older host restarted an entry it kept)', () => {
    const running = [live(1, '/wt/a', 1_500)];
    expect(agentsOnOldHooks({ ...base, running, fromHost: (pid) => pid === 1 }).map((a) => a.pid)).toEqual([1]);
    expect(agentsOnOldHooks({ ...base, running: [live(2, '/wt/a', 1_500)], fromHost: () => true })).toEqual([]); // has its own
  });

  it('an unknown start time or a command line that can’t be read counts as old: the hooks stay rather than a session losing them', () => {
    expect(agentsOnOldHooks({ ...base, running: [live(2, '/wt/a', null)] })).toEqual([]); // known to have them
    expect(agentsOnOldHooks({ ...base, running: [live(1, '/wt/a', null)] }).map((a) => a.pid)).toEqual([1]);
    expect(agentsOnOldHooks({ ...base, running: [live(9, '/wt/a', 500)] }).map((a) => a.pid)).toEqual([9]);
  });
});

describe('settleAgentHooks', () => {
  const agent = (running: LiveAgent[]) => {
    const events = { bridge: vi.fn(async () => {}), removeInstalled: vi.fn(async () => {}), read: vi.fn(), handOver: vi.fn() };
    const a = {
      id: 'claude',
      name: 'Claude Code',
      launch: { startedWithSessionHooks: withHooks },
      live: { running: () => running },
      events,
    } as unknown as AgentAdapter;
    return { a, events };
  };
  const io = (agents: AgentAdapter[], lines = new Map<number, string>()) => ({
    agents: () => agents,
    commandLines: async () => lines,
    inSession: () => true,
    since: SINCE,
  });

  it('bridges while an old agent runs, then removes once it is gone', async () => {
    const running = [live(1, '/wt/a', 500)];
    const { a, events } = agent(running);
    expect(await settleAgentHooks(io([a]))).toEqual([{ agent: 'claude', done: 'bridged', waitingOn: 1 }]);
    expect(events.bridge).toHaveBeenCalledOnce();
    expect(events.removeInstalled).not.toHaveBeenCalled();
    running.splice(0); // it was restarted with work's hooks, or quit
    expect(await settleAgentHooks(io([a]))).toEqual([{ agent: 'claude', done: 'removed' }]);
    expect(events.removeInstalled).toHaveBeenCalledOnce();
  });

  it('no process list (it failed): every session agent counts as old, so nothing is taken from under one', async () => {
    const { a, events } = agent([live(2, '/wt/a', 500)]);
    await settleAgentHooks({ ...io([a]), commandLines: async () => Promise.reject(new Error('ps failed')) });
    expect(events.bridge).toHaveBeenCalledOnce();
  });
});
