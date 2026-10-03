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

  it('with no diff on screen (all committed), every comment is still listed', () => {
    act(() => root.render(createElement(CommentsPanel, {})));
    expect(rows()).toHaveLength(3);
    expect(container.textContent).toContain('Comments (3)');
  });
});
