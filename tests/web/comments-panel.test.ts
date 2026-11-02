// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Comment } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ comments: [] as Comment[] }));
vi.mock('../../src/web/src/state/ReviewProvider.js', () => ({ useReview: () => ({ comments: h.comments }) }));
const { CommentsPanel } = await import('../../src/web/src/components/Sidebar/CommentsPanel.js');

const c = (over: Partial<Comment>): Comment =>
  ({
    id: over.id ?? 'x',
    repo: '',
    file: '',
    line: 0,
    side: 'general',
    body: 'b',
    createdAt: '',
    author: 'user',
    status: 'published',
    ...over,
  }) as Comment;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.comments = [
    c({ id: 'g', body: 'Overall: looks good' }),
    c({ id: 'a', repo: 'backend', file: 'src/a.ts', line: 3, side: 'right', body: 'Rename this' }),
    c({ id: 'b', repo: 'frontend', file: 'src/b.tsx', line: 9, side: 'right', body: 'Missing test' }),
    c({ id: 'r', repo: 'backend', file: 'src/a.ts', line: 3, side: 'right', body: 'reply', parentId: 'a' }),
  ];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const rows = () => [...container.querySelectorAll('.wd-comments-panel-row')];

describe('CommentsPanel: every comment of the review, in one list', () => {
  it("lists every repo's comments (replies under their parents), another repo's labelled", () => {
    act(() => root.render(createElement(CommentsPanel, { repoName: 'backend' })));
    expect(rows().map((r) => r.querySelector('.wd-comments-panel-loc')!.textContent)).toEqual([
      'General',
      'src/a.ts:3',
      'frontend · src/b.tsx:9',
    ]);
  });

  it('a click on another repo’s comment shows that repo', () => {
    const onOpenRepo = vi.fn();
    act(() => root.render(createElement(CommentsPanel, { repoName: 'backend', onOpenRepo })));
    act(() => (rows()[2] as HTMLElement).click());
    expect(onOpenRepo).toHaveBeenCalledWith('frontend');
    act(() => (rows()[1] as HTMLElement).click());
    expect(onOpenRepo).toHaveBeenCalledTimes(1); // its own repo: no switch
  });

  it('resolved ones go to the bottom, under their own heading', () => {
    h.comments = [
      c({ id: 'x', body: 'Done already', resolved: true }),
      c({ id: 'g', body: 'Overall: looks good' }),
      c({ id: 'a', repo: 'backend', file: 'src/a.ts', line: 3, side: 'right', body: 'Rename this' }),
    ];
    act(() => root.render(createElement(CommentsPanel, { repoName: 'backend' })));
    expect(rows().map((r) => r.querySelector('.wd-comments-panel-body')!.textContent)).toEqual([
      'Overall: looks good',
      'Rename this',
      'Done already',
    ]);
    expect(container.querySelector('.wd-comments-panel-divider')!.textContent).toBe('Resolved · 1');
    expect(rows()[2].textContent).toContain('Resolved:'); // said to a screen reader, not only struck through
  });

  it('with no diff on screen (all committed), every comment is still listed', () => {
    act(() => root.render(createElement(CommentsPanel, {})));
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain('Comments (3)');
  });
});

describe('a click on a comment always shows it (reported: a resolved one did nothing)', () => {
  it('not in the changes on screen: opened in place, whole, with its replies; a second click folds it', () => {
    h.comments = [
      c({
        id: 'a',
        repo: 'backend',
        file: 'src/Preprocessing/Author.cs',
        line: 12,
        side: 'right',
        body: 'This should not be adyen,\nsomething outside it',
        resolved: true,
      }),
      c({
        id: 'r',
        repo: 'backend',
        file: 'src/Preprocessing/Author.cs',
        line: 12,
        side: 'right',
        body: 'Moved it out.',
        author: 'claude',
        parentId: 'a',
      }),
    ];
    act(() => root.render(createElement(CommentsPanel, { repoName: 'backend' })));
    act(() => (rows()[0] as HTMLElement).click());
    const inline = container.querySelector('.wd-comments-panel-inline')!;
    expect(inline.querySelector('.wd-comments-panel-full')!.textContent).toBe('This should not be adyen,\nsomething outside it');
    expect(inline.querySelector('.wd-comments-panel-reply')!.textContent).toBe('Claude: Moved it out.');
    expect(inline.textContent).toContain('Not in the changes on screen');
    act(() => (rows()[0] as HTMLElement).click());
    expect(container.querySelector('.wd-comments-panel-inline')).toBeNull();
  });

  it('on screen as a resolved thread folded to one line: opened and scrolled to, not shown in the panel', () => {
    h.comments = [c({ id: 'a', repo: 'backend', file: 'src/a.ts', line: 3, side: 'right', body: 'Rename this', resolved: true })];
    const bar = document.createElement('button');
    bar.className = 'wd-comment-resolved-bar';
    bar.dataset.commentId = 'a';
    const opened = vi.fn();
    bar.addEventListener('click', opened);
    bar.scrollIntoView = vi.fn();
    document.body.appendChild(bar);
    try {
      act(() => root.render(createElement(CommentsPanel, { repoName: 'backend' })));
      act(() => (rows()[0] as HTMLElement).click());
      expect(opened).toHaveBeenCalled();
      expect(container.querySelector('.wd-comments-panel-inline')).toBeNull();
    } finally {
      bar.remove();
    }
  });
});

describe('the jump that waits for another repo to draw', () => {
  it('is dropped when the panel goes first (it ran on a page torn down, failing CI)', () => {
    vi.useFakeTimers();
    try {
      const onOpenRepo = vi.fn();
      const query = vi.spyOn(document, 'querySelector');
      act(() => root.render(createElement(CommentsPanel, { repoName: 'backend', onOpenRepo })));
      act(() => (rows()[2] as HTMLElement).click());
      expect(onOpenRepo).toHaveBeenCalledWith('frontend');
      act(() => root.unmount());
      query.mockClear();
      vi.advanceTimersByTime(200);
      expect(query).not.toHaveBeenCalled();
      root = createRoot(container); // afterEach unmounts it again
    } finally {
      vi.useRealTimers();
    }
  });
});
