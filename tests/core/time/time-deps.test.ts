import { describe, expect, it, vi } from 'vitest';
import { commitsWrittenOn, resetRefusedKeys, titlesOf } from '../../../src/core/time/time-deps.js';

describe('your commits that day (time-deps.ts)', () => {
  // Author dates as git prints them (%aI); local times, so the test holds in any time zone.
  const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
  const line = (sha: string, authored: string, committer: string, subject: string) => [sha, authored, committer, subject].join('\t');

  it('by the day it was written (a rebase or amend later counts on the day of the work); none GitHub committed (squash merges)', () => {
    const out = [
      line('a1', at(8, 10), 'you@example.com', 'APP-1: written today'),
      line('a2', at(6, 15), 'you@example.com', 'APP-2: written Tuesday, rebased today'),
      line('a3', at(8, 16), 'noreply@github.com', 'APP-1: the feature (#212)'),
      line('a4', at(8, 17), 'you@example.com', 'a subject\twith a tab'),
      line('a5', 'not a date', 'you@example.com', 'broken'),
      line('a6', at(8, 18), 'you@example.com', 'index on feat/PAY-12-x: abc123 wip'), // a stash's own commits
      line('a7', at(8, 18), 'you@example.com', 'untracked files on feat/PAY-12-x: abc123 wip'),
    ].join('\n');
    expect(commitsWrittenOn(out, '2026-10-08')).toEqual([
      { sha: 'a1', subject: 'APP-1: written today' },
      { sha: 'a4', subject: 'a subject\twith a tab' },
    ]);
    expect(commitsWrittenOn(out, '2026-10-06')).toEqual([{ sha: 'a2', subject: 'APP-2: written Tuesday, rebased today' }]);
    expect(commitsWrittenOn('', '2026-10-08')).toEqual([]);
  });
});

describe("the day's ticket titles (titlesOf)", () => {
  const issues: Record<string, { summary: string; statusCategory?: string }> = {
    'APP-1': { summary: 'One', statusCategory: 'done' },
    'APP-2': { summary: 'Two' },
  };
  // Like Jira: a key that doesn't exist fails the whole search.
  const search = vi.fn(async (jql: string) => {
    const keys = /key in \((.*)\)/.exec(jql)?.[1].split(', ') ?? [/key = (.*)/.exec(jql)![1]];
    if (keys.some((k) => !issues[k])) throw new Error(`An issue with key '${keys.find((k) => !issues[k])}' does not exist`);
    return keys.map((k) => ({ key: k, ...issues[k] }));
  });

  it("one search; one key Jira doesn't have (a branch's FOO-12): each key alone, keeping the ones found", async () => {
    expect(await titlesOf(['APP-1', 'APP-2'], search)).toEqual({
      'APP-1': { title: 'One', done: true },
      'APP-2': { title: 'Two', done: false },
    });
    expect(await titlesOf(['APP-1', 'FOO-12', 'APP-2', 'not a key'], search)).toEqual({
      'APP-1': { title: 'One', done: true },
      'APP-2': { title: 'Two', done: false },
    });
  });

  it("a key Jira refused stays out of the next searches (an hour), so a day with one isn't asked key by key every rebuild", async () => {
    resetRefusedKeys();
    search.mockClear();
    const t0 = Date.parse('2026-10-08T10:00:00Z');
    await titlesOf(['APP-1', 'FOO-12', 'APP-2'], search, t0);
    search.mockClear();
    expect(await titlesOf(['APP-1', 'FOO-12', 'APP-2'], search, t0 + 60_000)).toEqual({
      'APP-1': { title: 'One', done: true },
      'APP-2': { title: 'Two', done: false },
    });
    expect(search).toHaveBeenCalledTimes(1); // one search, without FOO-12
    search.mockClear();
    await titlesOf(['APP-1', 'FOO-12', 'APP-2'], search, t0 + 2 * 3600_000); // an hour on: asked again
    expect(search.mock.calls.some(([q]) => q.includes('FOO-12'))).toBe(true);
    resetRefusedKeys();
  });

  it('acli down (every search refused): throws, so the day keeps what it had', async () => {
    const down = async () => {
      throw new Error('acli: not signed in');
    };
    await expect(titlesOf(['APP-1', 'APP-2'], down)).rejects.toThrow('not signed in');
  });
});
