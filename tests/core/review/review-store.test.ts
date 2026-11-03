import { describe, expect, it } from 'vitest';
import {
  allReviews,
  isReview,
  keepOnly,
  readReview,
  updateReview,
  upsertReview,
  writeReview,
} from '../../../src/core/review/review-store.js';
import { withDb } from '../../../src/core/platform/db.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';

// Each test file has its own HOME (tests/setup): this state.db is a throwaway.

describe('prepared reviews in state.db', () => {
  it('written, read back, changed in a transaction; a row of the wrong shape is dropped, not trusted', () => {
    const r = demoReview(new Date('2026-11-02T10:00:00Z'));
    writeReview(r);
    expect(readReview('api', 231)).toEqual(r);
    const next = updateReview('api', 231, (cur) => ({ ...cur, drafts: cur.drafts.slice(1) }));
    expect(next?.drafts).toHaveLength(1);
    expect(readReview('api', 231)?.drafts).toHaveLength(1);
    expect(updateReview('api', 999, (c) => c)).toBeNull();
    withDb((d) => d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run('api#5', '{"repo":"api","number":5}'));
    expect(readReview('api', 5)).toBeNull();
    expect(allReviews().map((x) => x.number)).toEqual([231]);
    expect(isReview({ ...r, status: 'bogus' })).toBe(false);
    expect(isReview({ ...r, dropped: 'x' })).toBe(false);
    expect(isReview({ ...r, inDoubt: { at: 'now' } })).toBe(false);
    expect(isReview({ ...r, inDoubt: { at: 'now', event: 'comment', drafts: [], summary: null, error: 'e' } })).toBe(true);
    // Fix it myself's batches: shape-checked, each comment too; a fork is `true` or absent.
    const fix = { at: 'now', sessionId: 's1', branch: 'feat/x', comments: [{ path: 'a.cs', line: 3, body: 'b', by: 'ai' }] };
    expect(isReview({ ...r, fork: true, fixingMyself: [fix] })).toBe(true);
    expect(isReview({ ...r, fork: 'yes' })).toBe(false);
    expect(isReview({ ...r, fixingMyself: fix })).toBe(false);
    expect(isReview({ ...r, fixingMyself: [{ ...fix, sessionId: 1 }] })).toBe(false);
    expect(isReview({ ...r, fixingMyself: [{ ...fix, comments: [{ path: 'a.cs', line: '3', body: 'b' }] }] })).toBe(false);
  });

  it("drops the reviews of PRs no longer open — only for the repos asked (a repo that couldn't be listed keeps its own)", () => {
    writeReview({ ...demoReview(), number: 1 });
    writeReview({ ...demoReview(), number: 2 });
    writeReview({ ...demoReview(), repo: 'web', number: 3 });
    // api#5 (the malformed row above) is dropped by its key too.
    expect(keepOnly(['api'], new Set(['api#2', 'api#231']))).toEqual([
      { repo: 'api', number: 5 },
      { repo: 'api', number: 1 },
    ]);
    expect(
      allReviews()
        .map((x) => `${x.repo}#${x.number}`)
        .sort(),
    ).toEqual(['api#2', 'api#231', 'web#3']);
  });

  it('upsert reads and writes in one go: none stored gives null, a row of the wrong shape counts as none', () => {
    const seen: Array<number | null> = [];
    upsertReview('api', 40, (was) => {
      seen.push(was ? was.number : null);
      return { ...demoReview(), number: 40 };
    });
    upsertReview('api', 40, (was) => {
      seen.push(was ? was.number : null);
      return { ...was!, title: 'again' };
    });
    withDb((d) => d.prepare('INSERT OR REPLACE INTO pr_reviews (key, data) VALUES (?, ?)').run('api#41', '{"repo":"api"}'));
    upsertReview('api', 41, (was) => {
      seen.push(was ? was.number : null);
      return { ...demoReview(), number: 41 };
    });
    expect(seen).toEqual([null, 40, null]);
    expect(readReview('api', 40)!.title).toBe('again');
    expect(readReview('api', 41)!.number).toBe(41);
  });
});
