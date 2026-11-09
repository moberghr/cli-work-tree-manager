// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Comment } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  comments: [] as Comment[],
  openReplyTo: null as string | null,
  resolveComment: vi.fn(),
  deleteComment: vi.fn(),
  openReplyAt: vi.fn(),
}));
vi.mock('../../src/web/src/state/ReviewProvider.js', () => ({
  useReview: () => ({
    comments: h.comments,
    openReplyTo: h.openReplyTo,
    closeReply: vi.fn(),
    postComment: vi.fn(),
    resolveComment: h.resolveComment,
    deleteComment: h.deleteComment,
    openReplyAt: h.openReplyAt,
  }),
  selectReplies: (cs: Comment[], id: string) => cs.filter((c) => c.parentId === id),
  useReviewOptional: () => null,
}));
const { CommentItem } = await import('../../src/web/src/components/Review/CommentItem.js');

const comment = (over: Partial<Comment> = {}): Comment =>
  ({
    id: 'c1',
    repo: 'api',
    file: 'a.ts',
    line: 3,
    side: 'right',
    body: 'Rename this\nand that',
    createdAt: '2026-10-14T08:00:00Z',
    author: 'user',
    status: 'published',
    ...over,
  }) as Comment;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.comments = [];
  h.openReplyTo = null;
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));

describe('CommentItem', () => {
  it('a resolved thread folds to one line; Show opens it, and Hide (top right, where Show was) folds it back', () => {
    act(() => root.render(createElement(CommentItem, { comment: comment({ resolved: true }) })));
    expect(container.querySelector('.wd-comment-resolved-bar')).not.toBeNull();
    expect(container.querySelector('.wd-comment-resolved-bar .wd-comment-fold')!.textContent).toContain('Show');

    act(() => (container.querySelector('.wd-comment-resolved-bar') as HTMLElement).click());
    expect(container.querySelector('.wd-comment-resolved-bar')).toBeNull();
    const hide = container.querySelector('.wd-comment-head .wd-comment-fold') as HTMLButtonElement;
    expect(hide.textContent).toContain('Hide');

    act(() => hide.click());
    expect(container.querySelector('.wd-comment-resolved-bar')).not.toBeNull();
    expect(h.resolveComment).not.toHaveBeenCalled(); // folding is a view, not a change
  });

  it('Reply, Resolve and Delete as buttons; an open thread has no Hide', () => {
    act(() => root.render(createElement(CommentItem, { comment: comment() })));
    expect([...container.querySelectorAll('.wd-comment-actions button')].map((b) => b.textContent)).toEqual([
      'Reply',
      '✓ Resolve',
      'Delete',
    ]);
    expect(container.querySelector('.wd-comment-fold')).toBeNull();
    act(() => button('✓ Resolve')!.click());
    expect(h.resolveComment).toHaveBeenCalledWith('c1', true);
  });

  it('an opened resolved thread offers Reopen', () => {
    act(() => root.render(createElement(CommentItem, { comment: comment({ resolved: true }) })));
    act(() => (container.querySelector('.wd-comment-resolved-bar') as HTMLElement).click());
    act(() => button('Reopen')!.click());
    expect(h.resolveComment).toHaveBeenCalledWith('c1', false);
  });

  it('a reply being written keeps a resolved thread open, with no Hide (folding would lose the text)', () => {
    h.openReplyTo = 'c1';
    act(() => root.render(createElement(CommentItem, { comment: comment({ resolved: true }) })));
    expect(container.querySelector('.wd-comment-resolved-bar')).toBeNull();
    expect(container.querySelector('.wd-comment-fold')).toBeNull();
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('Delete asks once more, naming the replies that go with it; a pause forgets the first click', () => {
    vi.useFakeTimers();
    try {
      h.comments = [comment({ id: 'r1', parentId: 'c1', body: 'reply' })];
      act(() => root.render(createElement(CommentItem, { comment: comment() })));
      const del = () => container.querySelector('.wd-comment-btn-delete') as HTMLButtonElement;
      act(() => del().click());
      expect(h.deleteComment).not.toHaveBeenCalled();
      expect(del().textContent).toBe('Delete with 1 reply?');
      act(() => void vi.advanceTimersByTime(5000));
      expect(del().textContent).toBe('Delete');
      act(() => del().click());
      act(() => del().click());
      expect(h.deleteComment).toHaveBeenCalledWith('c1');
    } finally {
      vi.useRealTimers();
    }
  });
});
