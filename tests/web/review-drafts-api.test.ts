import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoReview } from '../../src/server/demo/demo-reviews.js';
import type { PrReviewWire } from '../../src/core/api-types.js';

const api = vi.hoisted(() => ({ fetchReview: vi.fn(), addReviewDraft: vi.fn(), discardReviewDraft: vi.fn() }));
vi.mock('../../src/web/src/api/panes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/panes.js')>()),
  ...api,
}));
const { draftsAsComments, reviewDraftsApi } = await import('../../src/web/src/api/review-drafts-api.js');

const H = 'src/Shop.Orders/Refunds/RefundHandler.cs';
let review: PrReviewWire;
beforeEach(() => {
  review = demoReview(new Date('2026-11-02T10:00:00Z'));
  for (const f of Object.values(api)) f.mockReset();
});

describe("a review's drafts as the diff's comments", () => {
  it('only the drafts not posted, on their lines (right side): the AI step’s as Claude’s, yours as yours', () => {
    const r: PrReviewWire = {
      ...review,
      drafts: [
        { ...review.drafts[0], state: 'posted' },
        review.drafts[1],
        { id: 'u1', path: H, line: 6, body: 'mine', state: 'draft', by: 'you' },
      ],
    };
    expect(draftsAsComments(r).map((c) => [c.id, c.file, c.line, c.side, c.author, c.status])).toEqual([
      ['d2', H, 7, 'right', 'claude', 'draft'],
      ['u1', H, 6, 'right', 'user', 'draft'],
    ]);
  });

  it('adding on a line makes a draft of the review; deleting removes it; each tells the tab the review as it now is', async () => {
    const onChange = vi.fn();
    const withMine = {
      ...review,
      drafts: [...review.drafts, { id: 'u1', path: H, line: 6, body: 'mine', state: 'draft' as const, by: 'you' as const }],
    };
    api.addReviewDraft.mockResolvedValue(withMine);
    api.discardReviewDraft.mockResolvedValue(review);
    const drafts = reviewDraftsApi('api', 231, onChange);
    const added = await drafts.post({ file: H, line: 6, side: 'right', body: 'mine' } as never);
    expect(api.addReviewDraft).toHaveBeenCalledWith('api', 231, { path: H, line: 6, body: 'mine' });
    expect(added.comments.map((c) => c.id)).toEqual(['d1', 'd2', 'u1']);
    expect(onChange).toHaveBeenCalledWith(withMine);
    const deleted = await drafts.delete('u1');
    expect(api.discardReviewDraft).toHaveBeenCalledWith('api', 231, 'u1');
    expect(deleted.comments.map((c) => c.id)).toEqual(['d1', 'd2']);
    // A whole-file or general comment has no line to go on.
    await expect(drafts.post({ body: 'general' } as never)).rejects.toThrow('a review comment goes on a line of the new side');
    api.fetchReview.mockResolvedValue(review);
    expect((await drafts.fetch()).map((c) => c.id)).toEqual(['d1', 'd2']);
    expect(drafts.draftsOnly).toBe(true);
  });
});
