// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { sessionMenuItems, type SessionMenuActions } from '../../src/web/src/state/session-menu.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';
import { RowMenu } from '../../src/web/src/components/Dashboard/RowMenu.js';
import { Toast, useToast } from '../../src/web/src/components/Dashboard/Toast.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id, target: 'api', branch: `feat/${id}`, isGroup: false, paths: [`C:\\wt\\${id}`], createdAt: now, lastAccessedAt: now,
    draftCount: 0, commentCount: 0, claudeCount: 0, ptyStatus: 'idle', lastActivity: null, activityState: 'stale',
    pendingForClaudeCount: 0, attention: null, diffStat: null, archivedAt: null, port: null, ...extra,
  }) as SessionSummary;

const actions = (): SessionMenuActions & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    setArchived: (s, a) => void calls.push(`${a ? 'archive' : 'restore'} ${s.id}`),
    openTerminal: (s) => void calls.push(`terminal ${s.id}`),
    openEditor: (s) => void calls.push(`editor ${s.id}`),
    copyBranch: (s) => void calls.push(`copy ${s.branch}`),
    remove: (s) => void calls.push(`delete ${s.id}`),
  };
};

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

describe('sessionMenuItems', () => {
  it("a live session: archive, open in terminal / editor, copy its branch, delete (in red)", () => {
    const a = actions();
    const items = sessionMenuItems(session('a'), a);
    expect(items.map((i) => i.label)).toEqual(['Archive', 'Open in terminal', 'Open in editor', 'Copy branch name', 'Delete…']);
    expect(items.find((i) => i.label === 'Delete…')).toMatchObject({ danger: true });
    for (const i of items) i.run();
    expect(a.calls).toEqual(['archive a', 'terminal a', 'editor a', 'copy feat/a', 'delete a']);
  });

  it('an archived one: restore, copy, delete — nothing that opens its folder', () => {
    expect(sessionMenuItems(session('b', { archivedAt: now }), actions()).map((i) => i.label)).toEqual(['Restore', 'Copy branch name', 'Delete…']);
  });
});

describe('the rail menu', () => {
  it('right-click: Rename, then what the app gives it, run on that session', async () => {
    const a = actions();
    act(() => root.render(createElement(SessionRail, { sessions: [session('a'), session('b')], activeSessionId: null, onSelect: () => {}, onNewWorktree: () => {}, onRename: async () => {}, menuFor: (s) => sessionMenuItems(s, a) })));
    const row = [...container.querySelectorAll('.wd-dash-rail-item')].find((r) => r.textContent?.includes('feat/b'))!;
    act(() => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.firstElementChild!.textContent)).toEqual(['Rename', 'Archive', 'Open in terminal', 'Open in editor', 'Copy branch name', 'Delete…']);
    act(() => items[2].click());
    expect(a.calls).toEqual(['terminal b']);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('RowMenu', () => {
  it('↓/↑ move between items, wrapping', () => {
    act(() => root.render(createElement(RowMenu, { x: 0, y: 0, onClose: () => {}, items: [{ label: 'One', run: () => {} }, { label: 'Two', run: () => {} }] })));
    const [one, two] = [...container.querySelectorAll<HTMLButtonElement>('button')];
    expect(document.activeElement).toBe(one);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    expect(document.activeElement).toBe(two);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    expect(document.activeElement).toBe(one);
  });

  it('a re-render (a background refresh) keeps where ↓ moved to; Tab closes it', () => {
    const onClose = vi.fn();
    const items = [{ label: 'One', run: () => {} }, { label: 'Two', run: () => {} }];
    act(() => root.render(createElement(RowMenu, { x: 0, y: 0, onClose: () => onClose(), items })));
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    const two = [...container.querySelectorAll<HTMLButtonElement>('button')][1];
    expect(document.activeElement).toBe(two);
    act(() => root.render(createElement(RowMenu, { x: 0, y: 0, onClose: () => onClose(), items: [...items] }))); // new closure, new items
    expect(document.activeElement).toBe([...container.querySelectorAll<HTMLButtonElement>('button')][1]);
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })));
    expect(onClose).toHaveBeenCalled();
  });

  it('F2 while a row menu is open does not start renaming the open session', () => {
    act(() => root.render(createElement(SessionRail, { sessions: [session('a'), session('b')], activeSessionId: 'a', onSelect: () => {}, onNewWorktree: () => {}, onRename: async () => {}, menuFor: () => [] })));
    const row = [...container.querySelectorAll('.wd-dash-rail-item')].find((r) => r.textContent?.includes('feat/b'))!;
    act(() => void row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', cancelable: true })));
    expect(container.querySelector('.wd-dash-rail-rename')).toBeNull();
  });

  it('opened near the window’s edge, it moves back inside', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 160, height: 200, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
    act(() => root.render(createElement(RowMenu, { x: window.innerWidth - 10, y: window.innerHeight - 10, onClose: () => {}, items: [{ label: 'One', run: () => {} }] })));
    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    expect(parseFloat(menu.style.left)).toBe(window.innerWidth - 164);
    expect(parseFloat(menu.style.top)).toBe(window.innerHeight - 204);
    vi.restoreAllMocks();
  });
});

describe('Toast', () => {
  it('shows a message, goes on a click', () => {
    vi.useFakeTimers();
    let api!: ReturnType<typeof useToast>;
    function Host() {
      api = useToast(1000);
      return createElement(Toast, { toast: api.toast, onClose: api.hide });
    }
    act(() => root.render(createElement(Host)));
    act(() => api.show({ text: "Couldn't open the editor: code not found", kind: 'error' }));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Couldn't open the editor: code not found");
    act(() => vi.advanceTimersByTime(2100)); // an error stays twice as long
    expect(container.querySelector('[role="alert"]')).toBeNull();
    act(() => api.show({ text: 'Copied feat/a' }));
    act(() => (container.querySelector('[role="status"]') as HTMLElement).click());
    expect(container.querySelector('[role="status"]')).toBeNull();
    vi.useRealTimers();
  });
});
