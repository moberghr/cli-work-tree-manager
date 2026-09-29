import { describe, it, expect, vi } from 'vitest';
import { createPrWatch, ciFixMessage, type PrWatchDeps } from '../../src/core/pr-watch.js';
import type { RepoShipState, ShipPr, ShipPreflight } from '../../src/core/api-types.js';
import type { WorktreeSession } from '../../src/core/session-types.js';
import type { ReviewFeedback } from '../../src/core/pr-review.js';

const session = (isGroup = false): WorktreeSession => ({
  target: isGroup ? 'shop' : 'api', branch: 'feat/x', isGroup, paths: [], createdAt: '', lastAccessedAt: '',
});
const pr = (over: Partial<ShipPr> = {}): ShipPr => ({
  number: 7, url: 'u', state: 'OPEN', isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'aaa', ...over,
});
const repo = (name: string, p: ShipPr | null, done = false): RepoShipState =>
  ({ name, path: `/wt/${name}`, pr: p, done, mergeBlockers: [] } as unknown as RepoShipState);

const ON = { autoArchive: true, fixCi: true, reviewComments: true };
function harness(repos: RepoShipState[], opts = ON, isGroup = false, feedback: ReviewFeedback | null = null) {
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
    reviewFeedback: vi.fn(async () => feedback),
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
    expect(h.deps.tell.mock.calls[0][1]).toContain('DECISION NEEDED: <the question>');

    h.set([repo('api', failing('bbb'))]);
    await h.watch.tick();
    expect(h.deps.tell).toHaveBeenCalledTimes(2);
  });

  it('with fixCi off, it only watches', async () => {
    const h = harness([repo('api', failing())], { ...ON, fixCi: false });
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
    const h = harness([repo('api', pr({ state: 'MERGED' }), true)], { ...ON, autoArchive: false });
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

  describe('review feedback', () => {
    const thread = (id: string, author: string, resolved = false) => ({
      id: `T${id}`, isResolved: resolved, isOutdated: false, path: 'src/a.ts', line: 3,
      comments: [{ id, author, body: `fix ${id}`, url: `u${id}`, createdAt: '' }],
    });
    const fb = (threads: ReviewFeedback['threads']): ReviewFeedback => ({ viewer: 'me', threads, reviews: [], comments: [] });
    const told = (h: ReturnType<typeof harness>) => (h.deps.tell.mock.calls as unknown as Array<[string, string]>).map((c) => c[1]);

    it('hands new review threads to Claude once, and counts open ones for the strip', async () => {
      const h = harness([repo('api', pr())], ON, false, fb([thread('1', 'alice'), thread('2', 'me'), thread('3', 'bob', true)]));
      await h.watch.tick();
      expect(h.deps.reviewFeedback).toHaveBeenCalledWith('/wt/api', 7);
      expect(told(h)).toHaveLength(1);
      expect(told(h)[0]).toContain('src/a.ts:3 — @alice: "fix 1"');
      expect(told(h)[0]).not.toContain('fix 2');
      expect(told(h)[0]).not.toContain('fix 3');
      expect(told(h)[0]).toContain('DECISION NEEDED:');
      expect(h.watch.state('s1')?.repos[0].openThreads).toBe(1);
      await h.watch.tick();
      expect(told(h)).toHaveLength(1);
    });

    it('only looks at open PRs, and not at all when turned off', async () => {
      const merged = harness([repo('api', pr({ state: 'MERGED' }), true)], ON, false, fb([thread('1', 'alice')]));
      await merged.watch.tick();
      expect(merged.deps.reviewFeedback).not.toHaveBeenCalled();
      const off = harness([repo('api', pr())], { ...ON, reviewComments: false }, false, fb([thread('1', 'alice')]));
      await off.watch.tick();
      expect(off.deps.reviewFeedback).not.toHaveBeenCalled();
      expect(off.deps.tell).not.toHaveBeenCalled();
    });

    it('CI failures and review feedback arrive as separate notes', async () => {
      const h = harness([repo('api', failing())], ON, false, fb([thread('1', 'alice')]));
      await h.watch.tick();
      expect(told(h).map((m) => m.split('\n')[0])).toEqual(['New review feedback on GitHub:', 'CI is failing:']);
    });
  });
});
