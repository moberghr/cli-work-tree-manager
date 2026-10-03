// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();
const session = (id: string, branch: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    target: 'api',
    branch,
    isGroup: false,
    paths: [`C:\\wt\\${id}`],
    createdAt: now,
    lastAccessedAt: now,
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'idle',
    lastActivity: null,
    activityState: 'stale',
    pendingForClaudeCount: 0,
    attention: null,
    diffStat: null,
    archivedAt: null,
    port: null,
    ...extra,
  }) as SessionSummary;
const SESSIONS = [
  session('a', 'fix/keys', { title: 'Rotate keys', titleIsYours: true }),
  session('b', 'feat/csv', { title: 'Add a CSV export' }),
];

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

const render = (onRename = vi.fn(async () => {}), activeSessionId: string | null = null) => {
  act(() =>
    root.render(createElement(SessionRail, { sessions: SESSIONS, activeSessionId, onSelect: () => {}, onNewWorktree: () => {}, onRename })),
  );
  return onRename;
};
const row = (branch: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-item')].find((b) => b.textContent?.includes(branch))!;
const field = () => container.querySelector<HTMLInputElement>('.wd-dash-rail-rename');
const key = (el: EventTarget, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const type = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('SessionRail: renaming a session', () => {
  it('F2 on a row: your name to edit, Enter saves it', async () => {
    const onRename = render();
    act(() => void key(row('fix/keys'), 'F2'));
    expect(field()!.value).toBe('Rotate keys');
    act(() => type(field()!, '  Rotate terminal keys '));
    await act(async () => void key(field()!, 'Enter'));
    expect(onRename).toHaveBeenCalledWith('a', 'Rotate terminal keys');
    expect(field()).toBeNull();
  });

  it('an automatic name starts empty (empty = keep it automatic); Esc cancels', async () => {
    const onRename = render();
    act(() => void key(row('feat/csv'), 'F2'));
    expect(field()!.value).toBe('');
    expect(field()!.placeholder).toBe('Add a CSV export');
    act(() => void key(field()!, 'Escape'));
    expect(field()).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it('right-click → Rename', async () => {
    render();
    act(
      () =>
        void row('feat/csv').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 20 })),
    );
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(item.textContent).toContain('Rename');
    act(() => item.click());
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(field()!.getAttribute('aria-label')).toBe('Name for feat/csv');
  });

  it('F2 anywhere renames the open session, but not while typing in a field (or a terminal)', () => {
    render(
      vi.fn(async () => {}),
      'b',
    );
    const input = document.createElement('textarea'); // xterm's input is a textarea
    document.body.appendChild(input);
    input.focus();
    act(() => void key(window, 'F2'));
    expect(field()).toBeNull();
    input.blur();
    input.remove();
    act(() => void key(window, 'F2'));
    expect(field()!.getAttribute('aria-label')).toBe('Name for feat/csv');
  });

  it('a failed rename keeps the field open with the reason', async () => {
    render(vi.fn(async () => Promise.reject(new Error('renaming failed (500)'))));
    act(() => void key(row('fix/keys'), 'F2'));
    await act(async () => void key(field()!, 'Enter'));
    expect(field()).not.toBeNull();
    expect(container.textContent).toContain('renaming failed (500)');
  });

  it('your name is the row’s label, with repo and branch beneath; an automatic one keeps the branch first', () => {
    render();
    const named = row('Rotate keys');
    expect(named.querySelector('.wd-dash-rail-name')!.textContent).toBe('Rotate keys');
    expect(named.querySelector('.wd-dash-rail-summary')!.textContent).toBe('api · fix/keys');
    expect(row('feat/csv').querySelector('.wd-dash-rail-name')!.textContent).toBe('feat/csv');
  });

  it('a worktree on another branch says so in the row’s tooltip', () => {
    act(() =>
      root.render(
        createElement(SessionRail, {
          sessions: [session('c', 'tmp/encryption-keys', { onOtherBranch: [{ repo: 'api', branch: 'fix/terminal-encryption-key-nexo' }] })],
          activeSessionId: null,
          onSelect: () => {},
          onNewWorktree: () => {},
        }),
      ),
    );
    expect(row('tmp/encryption-keys').title).toContain('api · tmp/encryption-keys (on fix/terminal-encryption-key-nexo)');
  });

  it('without onRename, no menu and F2 does nothing', () => {
    act(() =>
      root.render(createElement(SessionRail, { sessions: SESSIONS, activeSessionId: 'a', onSelect: () => {}, onNewWorktree: () => {} })),
    );
    act(() => void row('fix/keys').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    act(() => void key(row('fix/keys'), 'F2'));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(field()).toBeNull();
  });
});
