// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();
const session = (id: string, target: string): SessionSummary =>
  ({
    id,
    target,
    branch: `feat/${id}`,
    isGroup: false,
    paths: [`/wt/${id}`],
    createdAt: now,
    lastAccessedAt: now,
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'idle',
    lastActivity: null,
    activityState: 'open',
    pendingForClaudeCount: 0,
    attention: null,
    diffStat: null,
    archivedAt: null,
    port: null,
  }) as SessionSummary;
const SESSIONS = [session('a', 'alpha'), session('b', 'beta'), session('c', 'gamma')];

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (order: string[], onReorder = vi.fn()) => {
  act(() =>
    root.render(
      createElement(SessionRail, {
        sessions: SESSIONS,
        activeSessionId: null,
        onSelect: () => {},
        onNewWorktree: () => {},
        order,
        onReorder,
      }),
    ),
  );
  return onReorder;
};
const names = () => [...container.querySelectorAll('.wd-dash-rail-name')].map((n) => n.textContent);
const rows = () => [...container.querySelectorAll<HTMLLIElement>('.wd-dash-rail-list > li[draggable]')];

/** jsdom has no DragEvent: a plain event with what the rail reads. */
function drag(el: Element, type: string, clientY = 0) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { setData: () => {}, effectAllowed: '' } });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  act(() => {
    el.dispatchEvent(ev);
  });
}

describe('SessionRail order', () => {
  it('shows your order', () => {
    render(['c', 'a', 'b']);
    expect(names()).toEqual(['feat/c', 'feat/a', 'feat/b']);
  });

  it('Alt+↑ moves a row up one', () => {
    const onReorder = render([]);
    const third = container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-item')[2];
    act(() => {
      third.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    });
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('dragging a row onto the top half of another puts it in front', () => {
    const onReorder = render([]);
    const [first, , third] = rows();
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect);
    drag(third, 'dragstart');
    drag(first, 'dragover', 5); // top half
    expect(first.className).toContain('wd-dash-rail-drop-before');
    drag(first, 'drop', 5);
    expect(onReorder).toHaveBeenCalledWith(['c', 'a', 'b']);
  });

  it('a release between rows (no row under the pointer) still does what the bar shows', () => {
    const onReorder = render([]);
    const [first, , third] = rows();
    const list = container.querySelector('.wd-dash-rail-list')!;
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect);
    drag(third, 'dragstart');
    drag(first, 'dragover', 35); // bottom half: the bar under the first row
    // The gap below it: the list's own dragover must allow the drop (no 🚫).
    const over = new Event('dragover', { bubbles: true, cancelable: true });
    act(() => {
      list.dispatchEvent(over);
    });
    expect(over.defaultPrevented).toBe(true);
    drag(list, 'drop');
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('dragged out of the list, the bar goes and a release moves nothing', () => {
    const onReorder = render([]);
    const [first, , third] = rows();
    const list = container.querySelector('.wd-dash-rail-list')!;
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect);
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 250, top: 0, bottom: 600 } as DOMRect);
    drag(third, 'dragstart');
    drag(first, 'dragover', 5);
    const leave = (clientX: number, clientY: number) => {
      // WebKit leaves relatedTarget null, even going from one row to the next: only the pointer says where it is.
      const ev = new Event('dragleave', { bubbles: true });
      Object.defineProperties(ev, { relatedTarget: { value: null }, clientX: { value: clientX }, clientY: { value: clientY } });
      act(() => {
        list.dispatchEvent(ev);
      });
    };
    leave(100, 30); // between two rows, still inside the list
    expect(first.className).toContain('wd-dash-rail-drop-before');
    leave(400, 30); // out over the page
    expect(first.className).not.toContain('wd-dash-rail-drop-before');
    drag(list, 'drop');
    expect(onReorder).not.toHaveBeenCalled();
  });
});
