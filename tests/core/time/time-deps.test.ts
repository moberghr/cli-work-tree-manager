import { describe, expect, it } from 'vitest';
import { commitsWrittenOn } from '../../../src/core/time/time-deps.js';

describe('your commits that day (time-deps.ts)', () => {
  // Author dates as git prints them (%aI); local times, so the test holds in any time zone.
  const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
  const line = (sha: string, authored: string, committer: string, subject: string) => [sha, authored, committer, subject].join('\t');

  it('by the day it was written (a rebase or amend later counts on the day of the work); none GitHub committed (squash merges)', () => {
    const out = [
      line('a1', at(8, 10), 'you@moberg.hr', 'SD-1: written today'),
      line('a2', at(6, 15), 'you@moberg.hr', 'SD-2: written Tuesday, rebased today'),
      line('a3', at(8, 16), 'noreply@github.com', 'SD-1: the feature (#212)'),
      line('a4', at(8, 17), 'you@moberg.hr', 'a subject\twith a tab'),
      line('a5', 'not a date', 'you@moberg.hr', 'broken'),
    ].join('\n');
    expect(commitsWrittenOn(out, '2026-10-08')).toEqual([
      { sha: 'a1', subject: 'SD-1: written today' },
      { sha: 'a4', subject: 'a subject\twith a tab' },
    ]);
    expect(commitsWrittenOn(out, '2026-10-06')).toEqual([{ sha: 'a2', subject: 'SD-2: written Tuesday, rebased today' }]);
    expect(commitsWrittenOn('', '2026-10-08')).toEqual([]);
  });
});
