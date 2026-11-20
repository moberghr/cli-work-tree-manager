import { readReview } from './review-store.js';
import { describeReview } from './review-build.js';

/**
 * The Reviews tab's PR in words, as its review is now (state.db): what the Ctrl+K assistant's prompt hook adds at
 * each prompt, so a re-prepare or a submit since the tab said which PR shows at once — the stored context keeps only
 * which PR (`assistantContextReview`).
 */
export function describeReviewNow(repo: string, number: number): string {
  const r = readReview(repo, number);
  return r ? describeReview(r) : `The Reviews tab shows ${repo} PR #${number}: no review of it is prepared (any more).`;
}
