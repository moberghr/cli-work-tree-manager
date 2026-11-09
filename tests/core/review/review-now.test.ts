import { describe, expect, it } from 'vitest';
import { describeReviewNow } from '../../../src/core/review/review-now.js';
import { updateReview, writeReview } from '../../../src/core/review/review-store.js';
import { demoReview } from '../../../src/server/demo/demo-reviews.js';

// Each test file has its own HOME (tests/setup): this state.db is a throwaway.

describe('the Reviews tab’s PR, as its review is now', () => {
  it('none prepared says so; one prepared is described from state.db at each call, a change since showing at once', () => {
    expect(describeReviewNow('api', 231)).toBe('The Reviews tab shows api PR #231: no review of it is prepared (any more).');
    writeReview(demoReview(new Date('2026-11-02T10:00:00Z')));
    expect(describeReviewNow('api', 231)).toContain('2 draft comment(s) wait');
    updateReview('api', 231, (r) => ({ ...r, drafts: r.drafts.map((d) => ({ ...d, state: 'posted' as const })) }));
    expect(describeReviewNow('api', 231)).toContain('0 draft comment(s) wait');
    expect(describeReviewNow('api', 999)).toContain('no review of it is prepared');
    // Comments taken off to fix yourself: said, with where they went (fenced: paths and branches are the PR's).
    updateReview('api', 231, (r) => ({
      ...r,
      fixingMyself: [{ at: 'now', sessionId: 's1', branch: 'feat/refunds', comments: [{ path: 'a.cs', line: 3, body: 'b' }] }],
    }));
    expect(describeReviewNow('api', 231)).toContain(
      '1 comment(s) taken off the review: the user is fixing them in a session instead of posting them (Fix it myself), on <<< feat/refunds >>>: <<< a.cs:3 >>>.',
    );
  });
});
