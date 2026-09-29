import { describe, it, expect, vi } from 'vitest';
import { createPrWatch, ciFixMessage, type PrWatchDeps } from '../../src/core/pr-watch.js';
import type { RepoShipState, ShipPr, ShipPreflight } from '../../src/core/api-types.js';
import type { WorktreeSession } from '../../src/core/session-types.js';

const session = (isGroup = false): WorktreeSession => ({
  target: isGroup ? 'shop' : 'api', branch: 'feat/x', isGroup, paths: [], createdAt: '', lastAccessedAt: '',
});
const pr = (over: Partial<ShipPr> = {}): ShipPr => ({
  number: 7, url: 'u', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'aaa', ...over,
});
const repo = (name: string, p: ShipPr | null, done = false): RepoShipState =>
  ({ name, pr: p, done, mergeBlockers: [] } as unknown as RepoShipState);

function harness(repos: RepoShipState[], opts = { autoArchive: true, fixCi: true }, isGroup = false) {
  let pre: ShipPreflight = { repos };
  const told = new Set<string>();
  const deps = {
    sessions: () => [{ id: 's1', session: session(isGroup) }],
    preflight: vi.fn(async () => pre),
    archive: vi.fn(async () => {}),
    tell: vi.fn(async () => {}),
    broadcast: vi.fn(),
    options: () => opts,
    told: { has: (k: string) => told.has(k), add: (k: string) => void told.add(k) },
  } satisfies PrWatchDeps;
  return { deps, watch: createPrWatch(deps), set: (r: RepoShipState[]) => (pre = { repos: r }) };
}
const failing = (sha = 'aaa') => pr({ checks: 'fail', headSha: sha, failing: [{ name: 'test' }, { name: 'lint' }] });

describe('PR watch', () => {
  it('tells Claude once per failing head commit, and again after a push that fails too', async () => {
    const h = harness([repo('api', failing())]);
    await h.watch.tick();
    await h.watch.tick();
    expect(h.deps.tell).toHaveBeenCalledTimes(1);
    expect(h.deps.tell.mock.calls[0][1]).toContain('PR #7: test, lint');
    expect(h.deps.tell.mock.calls[0][1]).toContain('stop and ask me');

    h.set([repo('api', failing('bbb'))]);
    await h.watch.tick();
    expect(h.deps.tell).toHaveBeenCalledTimes(2);
  });

  it('with fixCi off, it only watches', async () => {
    const h = harness([repo('api', failing())], { autoArchive: true, fixCi: false });
    await h.watch.tick();
    expect(h.deps.tell).not.toHaveBeenCalled();
    expect(h.watch.state('s1')?.repos[0].pr?.checks).toBe('fail');
  });

  it('archives once every repo is done and something merged', async () => {
    const h = harness([repo('api', pr({ state: 'MERGED' }), true)]);
    await h.watch.tick();
    expect(h.deps.archive).toHaveBeenCalledWith('s1');
  });

  it('a group merged only in part stays open', async () => {
    const h = harness([repo('backend', pr({ state: 'MERGED' }), true), repo('frontend', pr(), false)], undefined, true);
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
    // …and untouched repos count as done, but nothing merged means no archive.
    const h2 = harness([repo('a', null, true), repo('b', null, true)], undefined, true);
    await h2.watch.tick();
    expect(h2.deps.archive).not.toHaveBeenCalled();
  });

  it('respects autoArchive off', async () => {
    const h = harness([repo('api', pr({ state: 'MERGED' }), true)], { autoArchive: false, fixCi: true });
    await h.watch.tick();
    expect(h.deps.archive).not.toHaveBeenCalled();
  });

  it('broadcasts ci-changed only when something changed', async () => {
    const h = harness([repo('api', pr({ checks: 'pending' }))]);
    await h.watch.tick();
    await h.watch.tick();
    expect(h.deps.broadcast).toHaveBeenCalledTimes(1);
    h.set([repo('api', pr({ checks: 'pass' }))]);
    await h.watch.tick();
    expect(h.deps.broadcast).toHaveBeenCalledTimes(2);
  });

  it('fixNow asks exactly once, even for a failure the sweep has not seen', async () => {
    const h = harness([repo('api', failing())]);
    expect(await h.watch.fixNow('s1')).toBe(true);
    expect(h.deps.tell).toHaveBeenCalledTimes(1);
    await h.watch.tick(); // already told for this head
    expect(h.deps.tell).toHaveBeenCalledTimes(1);
    h.set([repo('api', pr())]);
    expect(await h.watch.fixNow('s1')).toBe(false);
  });

  it('overlapping sweeps collapse into one', async () => {
    const h = harness([repo('api', pr())]);
    await Promise.all([h.watch.tick(), h.watch.tick()]);
    expect(h.deps.preflight).toHaveBeenCalledTimes(1);
  });

  it('a gh failure keeps the last known state', async () => {
    const h = harness([repo('api', pr({ checks: 'pending' }))]);
    await h.watch.tick();
    h.deps.preflight.mockRejectedValueOnce(new Error('gh down'));
    await h.watch.tick();
    expect(h.watch.state('s1')?.repos[0].pr?.checks).toBe('pending');
  });

  it('names the repo in a group message', () => {
    expect(ciFixMessage([{ repo: 'backend', number: 3, checks: ['lint'] }], true)).toContain('PR #3 (backend): lint');
  });
});
