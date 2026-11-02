import { describe, expect, it } from 'vitest';
import { allReviews, isReview, keepOnly, readReview, updateReview, writeReview } from '../../../src/core/review/review-store.js';
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
  });

  it("drops the reviews of PRs no longer open — only for the repos asked (a repo that couldn't be listed keeps its own)", () => {
    writeReview({ ...demoReview(), number: 1 });
    writeReview({ ...demoReview(), number: 2 });
    writeReview({ ...demoReview(), repo: 'web', number: 3 });
    expect(keepOnly(['api'], new Set(['api#2']))).toBeGreaterThanOrEqual(1);
    expect(
      allReviews()
        .map((x) => `${x.repo}#${x.number}`)
        .sort(),
    ).toEqual(['api#2', 'web#3']);
  });
});
