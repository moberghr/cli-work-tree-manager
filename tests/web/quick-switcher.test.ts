// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { switcherLabel, switcherResults } from '../../src/web/src/state/quick-switch.js';
import { QuickSwitcher, useQuickSwitcher } from '../../src/web/src/components/Dashboard/QuickSwitcher.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const session = (id: string, branch: string, minAgo: number, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id, target: 'straumur', branch, isGroup: false, paths: [`C:\\wt\\${id}`], createdAt: at(minAgo), lastAccessedAt: at(minAgo),
    draftCount: 0, commentCount: 0, claudeCount: 0, ptyStatus: 'idle', lastActivity: null, activityState: 'stale',
    pendingForClaudeCount: 0, attention: null, diffStat: null, archivedAt: null, port: null, ...extra,
  }) as SessionSummary;

const SESSIONS = [
  session('a', 'fix/pdf-generation-speed', 30, { title: 'PDF speed', titleIsYours: true }),
  session('b', 'feat/stored-cards', 5),
  session('c', 'task/notes-split', 600, { archivedAt: at(500) }),
  session('d', 'chore/update-pdf-lib', 90),
];

describe('switcherResults', () => {
  it('nothing typed: the ones used last, no archived', () => {
    expect(switcherResults(SESSIONS, '  ').map((s) => s.id)).toEqual(['b', 'a', 'd']);
  });

  it('typed: a name or branch starting with it first, then anything that has it, archived last', () => {
    expect(switcherResults(SESSIONS, 'pdf').map((s) => s.id)).toEqual(['a', 'd']); // "PDF speed" starts with it; "update-pdf-lib" has a part that does too, used later
    expect(switcherResults(SESSIONS, 'notes').map((s) => s.id)).toEqual(['c']); // found, though archived
    expect(switcherResults(SESSIONS, 'stra cards').map((s) => s.id)).toEqual(['b']); // every word, anywhere
  });

  it('several words rank by each word: the one where every word starts a name part comes first', () => {
    // Both match "pdf spe" (x has "speedier" in its status summary), but only y's name parts start with both words.
    const summary = { state: 'idle' as const, seen: true, since: at(1), updatedAt: at(1), summary: 'made the export speedier', stale: false };
    const two = [session('x', 'fix/old-pdf-thing', 1, { target: 'misc', attention: summary }), session('y', 'feat/pdf-speed', 50, { target: 'misc' })];
    expect(switcherResults(two, 'pdf spe').map((s) => s.id)).toEqual(['y', 'x']);
  });

  it('labels: your name, else the branch', () => {
    expect(switcherLabel(SESSIONS[0])).toBe('PDF speed');
    expect(switcherLabel(SESSIONS[1])).toBe('feat/stored-cards');
  });
});

describe('QuickSwitcher', () => {
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
  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const type = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k: string) => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('focused on open; type, ↓, Enter opens that one and closes', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(createElement(QuickSwitcher, { sessions: SESSIONS, onOpen, onClose })));
    expect(document.activeElement).toBe(input());
    act(() => type('pdf'));
    act(() => void key('ArrowDown'));
    act(() => void key('Enter'));
    expect(onOpen).toHaveBeenCalledWith('d');
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('Esc closes without opening; no match says so', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(createElement(QuickSwitcher, { sessions: SESSIONS, onOpen, onClose })));
    act(() => type('zzz'));
    expect(container.textContent).toContain('No session matches “zzz”');
    act(() => void key('Escape'));
    expect(onClose).toHaveBeenCalledWith(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Tab stays in the switcher', () => {
    act(() => root.render(createElement(QuickSwitcher, { sessions: SESSIONS, onOpen: () => {}, onClose: () => {} })));
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    act(() => void input().dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('useQuickSwitcher (Ctrl+P)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let api!: ReturnType<typeof useQuickSwitcher>;
  function Host() {
    api = useQuickSwitcher();
    return createElement('span', null, api.open ? 'open' : 'closed');
  }
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(Host)));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelectorAll('.stray').forEach((n) => n.remove());
  });
  const ctrlP = () => {
    const ev = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void window.dispatchEvent(ev));
    return ev;
  };

  it('opens and closes, never letting the print dialog through; closing puts focus back (the terminal)', async () => {
    const term = document.createElement('textarea');
    term.className = 'stray';
    document.body.appendChild(term);
    term.focus();
    expect(ctrlP().defaultPrevented).toBe(true);
    expect(container.textContent).toBe('open');
    term.blur();
    ctrlP();
    expect(container.textContent).toBe('closed');
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(term);
  });

  it('not over another dialog (a confirmation in progress)', () => {
    const dialog = document.createElement('div');
    dialog.className = 'stray';
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    expect(ctrlP().defaultPrevented).toBe(true);
    expect(container.textContent).toBe('closed');
  });

});
