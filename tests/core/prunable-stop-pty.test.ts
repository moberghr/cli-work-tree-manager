import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * CLI removal must stop the session's Claude in the PTY host (it holds the
 * worktree open on Windows) — but ONLY when the worktree will actually be
 * removed: a refused, non-forced removal must leave the running agent alone.
 */
const order: string[] = [];
const refuse = new Set<string>();
vi.mock('../../src/core/pty-pool.js', () => ({
  stopSessionPty: vi.fn(async (t: string, b: string) => { order.push(`stop ${t}:${b}`); }),
}));
vi.mock('../../src/core/worktree.js', () => ({
  wouldRefuseRemoval: (p: string, force: boolean) => !force && refuse.has(p),
  removeSingleWorktree: (_repo: string, wt: string, _b: string, force: boolean) => {
    order.push(`remove ${wt}`);
    return force || !refuse.has(wt);
  },
}));
vi.mock('../../src/core/history.js', () => ({ removeSession: vi.fn(async () => {}) }));

import { removeGroupEntry, removeSingleEntry } from '../../src/core/prunable-scan.js';

const single = { target: 'api', branch: 'feat/x', repos: [{ alias: 'api', repoPath: '/r/api', worktreePath: '/wt/api' }] };
const group = {
  target: 'shop', branch: 'feat/x',
  repos: [
    { alias: 'be', repoPath: '/r/be', worktreePath: '/wt/shop/be' },
    { alias: 'fe', repoPath: '/r/fe', worktreePath: '/wt/shop/fe' },
  ],
};
const config = { worktreesRoot: '/wt', repos: {}, groups: {}, copyFiles: [] };

beforeEach(() => {
  order.length = 0;
  refuse.clear();
});

describe('prune / sync stop the Claude first — only when removing', () => {
  it('single: stops, then removes', async () => {
    await removeSingleEntry(single as never, false);
    expect(order).toEqual(['stop api:feat/x', 'remove /wt/api']);
  });

  it('single, dirty, not forced: removal refused → the agent keeps running', async () => {
    refuse.add('/wt/api');
    await removeSingleEntry(single as never, false);
    expect(order).toEqual(['remove /wt/api']);
  });

  it('group: stopped only if every sub-repo will be removed', async () => {
    await removeGroupEntry(group as never, config as never, false);
    expect(order[0]).toBe('stop shop:feat/x');

    order.length = 0;
    refuse.add('/wt/shop/fe');
    await removeGroupEntry(group as never, config as never, false);
    expect(order.some((o) => o.startsWith('stop'))).toBe(false);

    order.length = 0;
    await removeGroupEntry(group as never, config as never, true); // --force removes regardless
    expect(order[0]).toBe('stop shop:feat/x');
  });
});
