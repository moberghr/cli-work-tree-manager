import { describe, it, expect } from 'vitest';
import {
  selectPublishedCount,
  selectDrafts,
} from '../../src/web/src/state/ReviewProvider.js';
import type { Comment } from '../../src/web/src/api/client.js';

function comment(over: Partial<Comment>): Comment {
  return {
    id: Math.random().toString(36).slice(2),
    repo: 'repo',
    file: 'a.ts',
    line: 1,
    side: 'right',
    body: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    author: 'user',
    status: 'published',
    ...over,
  };
}

describe('selectPublishedCount', () => {
  it("counts the user's published comments", () => {
    expect(
      selectPublishedCount([comment({}), comment({})]),
    ).toBe(2);
  });

  it("does NOT count Claude's published replies (the End-review badge bug)", () => {
    // One user comment + one Claude reply → must read as 1, not 2.
    const c = [
      comment({ id: 'u1', author: 'user' }),
      comment({ id: 'c1', author: 'claude', parentId: 'u1' }),
    ];
    expect(selectPublishedCount(c)).toBe(1);
  });

  it('ignores drafts', () => {
    expect(
      selectPublishedCount([
        comment({ status: 'draft' }),
        comment({ status: 'published' }),
      ]),
    ).toBe(1);
  });
});

describe('selectDrafts', () => {
  it('returns only draft comments', () => {
    const c = [comment({ status: 'draft' }), comment({ status: 'published' })];
    expect(selectDrafts(c)).toHaveLength(1);
    expect(selectDrafts(c)[0].status).toBe('draft');
  });
});
