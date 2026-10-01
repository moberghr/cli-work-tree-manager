// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { switcherLabel, switcherResults } from '../../src/web/src/state/quick-switch.js';
import { QuickSwitcher } from '../../src/web/src/components/Dashboard/QuickSwitcher.js';

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
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc closes without opening; no match says so', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(createElement(QuickSwitcher, { sessions: SESSIONS, onOpen, onClose })));
    act(() => type('zzz'));
    expect(container.textContent).toContain('No session matches “zzz”');
    act(() => void key('Escape'));
    expect(onClose).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
