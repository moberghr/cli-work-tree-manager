import { describe, it, expect } from 'vitest';
import { diffReviewSnapshot } from '../../src/core/review-poll.js';
import type { Comment } from '../../src/core/comment-types.js';

function comment(id: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id,
    repo: 'r',
    file: 'f.ts',
    line: 1,
    side: 'right',
    body: 'hi',
    createdAt: '2026-06-01T00:00:00.000Z',
    author: 'user',
    status: 'published',
    ...overrides,
  };
}

describe('diffReviewSnapshot', () => {
  it('emits every published comment the first time it appears', () => {
    const seen = new Set<string>();
    const snap = [comment('a'), comment('b'), comment('c')];

    const out = diffReviewSnapshot(snap, seen);

    expect(out.newComments.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(out.deleted).toEqual([]);
    expect(seen.size).toBe(3);
  });

  it('does NOT re-emit comments already in seen', () => {
    const seen = new Set<string>(['a', 'b']);
    const snap = [comment('a'), comment('b'), comment('c')];

    const out = diffReviewSnapshot(snap, seen);

    expect(out.newComments.map((c) => c.id)).toEqual(['c']);
    expect(seen.size).toBe(3);
  });

  it('skips draft comments — they only ship through submit-review', () => {
    const seen = new Set<string>();
    const snap = [
      comment('a', { status: 'draft' }),
      comment('b'),
      comment('c', { status: 'draft' }),
    ];

    const out = diffReviewSnapshot(snap, seen);

    expect(out.newComments.map((c) => c.id)).toEqual(['b']);
    // Drafts should NOT count toward seen — they haven't been emitted.
    expect(seen.has('a')).toBe(false);
    expect(seen.has('c')).toBe(false);
    expect(seen.has('b')).toBe(true);
  });

  it('detects deletions and removes them from seen (C-1 regression)', () => {
    // Setup: previously emitted a, b, c.
    const seen = new Set<string>(['a', 'b', 'c']);
    // Server now reports only a and c — b was deleted.
    const snap = [comment('a'), comment('c')];

    const out = diffReviewSnapshot(snap, seen);

    expect(out.deleted).toEqual(['b']);
    expect(out.newComments).toEqual([]);

    // Critical: `seen.size` is reported as the `--- review done --- total`.
    // If `b` lingered in `seen`, the count would be inflated by every
    // comment that was posted-then-deleted during the session.
    expect(seen.has('b')).toBe(false);
    expect(seen.size).toBe(2);
  });

  it('post-then-delete-then-end yields total=0, not 1', () => {
    // Simulates the full lifecycle that triggered C-1: a single comment
    // posted and then deleted before End Review.
    const seen = new Set<string>();

    // Tick 1: comment 'x' appears.
    diffReviewSnapshot([comment('x')], seen);
    expect(seen.size).toBe(1);

    // Tick 2: 'x' was deleted before End Review fired.
    const tick2 = diffReviewSnapshot([], seen);
    expect(tick2.deleted).toEqual(['x']);
    expect(seen.size).toBe(0); // <-- the bug was that this stayed at 1
  });

  it('handles a comment promoted from draft to published across ticks', () => {
    const seen = new Set<string>();
    // Tick 1: draft only — should not be emitted, should not be in seen.
    diffReviewSnapshot([comment('a', { status: 'draft' })], seen);
    expect(seen.size).toBe(0);

    // Tick 2: same id, now published (submitted) — emit it now.
    const tick2 = diffReviewSnapshot([comment('a', { status: 'published' })], seen);
    expect(tick2.newComments.map((c) => c.id)).toEqual(['a']);
    expect(seen.has('a')).toBe(true);
  });

  it('preserves snapshot order in newComments', () => {
    const seen = new Set<string>();
    const snap = [comment('z'), comment('a'), comment('m')];
    const out = diffReviewSnapshot(snap, seen);
    expect(out.newComments.map((c) => c.id)).toEqual(['z', 'a', 'm']);
  });

  it('idempotent when the snapshot is unchanged', () => {
    const seen = new Set<string>(['a']);
    const snap = [comment('a')];

    const first = diffReviewSnapshot(snap, seen);
    const second = diffReviewSnapshot(snap, seen);

    expect(first.newComments).toEqual([]);
    expect(first.deleted).toEqual([]);
    expect(second.newComments).toEqual([]);
    expect(second.deleted).toEqual([]);
    expect(seen.size).toBe(1);
  });
});
