// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { RailLayout, SectionOp } from '../../src/core/rail/rail-layout.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';
import { railMenuItems } from '../../src/web/src/state/rail-menu.js';
import { railGroups } from '../../src/web/src/state/session-display.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();
const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
const session = (id: string, lastAccessedAt = now): SessionSummary =>
  ({
    id,
    target: 'api',
    branch: `feat/${id}`,
    isGroup: false,
    paths: [`/wt/${id}`],
    createdAt: lastAccessedAt,
    lastAccessedAt,
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
  }) as SessionSummary;
const SESSIONS = [session('a'), session('b'), session('c'), session('d'), session('old', old)];
const LAYOUT: RailLayout = {
  sections: [
    { id: 'x', name: 'Client X' },
    { id: 'y', name: 'Waiting' },
  ],
  places: { c: { pinned: true }, old: { pinned: true }, b: { section: 'x' } },
};

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(over: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  const props = {
    sessions: SESSIONS,
    activeSessionId: null,
    onSelect: vi.fn(),
    onNewWorktree: () => {},
    layout: LAYOUT,
    onPlace: vi.fn(),
    onSections: vi.fn(async (_op: SectionOp) => {}),
    onReorder: vi.fn(),
    ...over,
  };
  act(() => root.render(createElement(SessionRail, props)));
  return props;
}
/** The list as shown: headings as `# name`, rows by branch. */
const shown = () =>
  [...container.querySelectorAll('.wd-dash-rail-group-name, .wd-dash-rail-name')].map((n) =>
    n.classList.contains('wd-dash-rail-group-name') ? `# ${n.textContent}` : n.textContent,
  );
const heading = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-group-toggle')].find((b) => b.textContent?.includes(name))!;
const row = (branch: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-item')].find(
    (b) => b.querySelector('.wd-dash-rail-name')?.textContent === branch,
  )!;
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((m) => m.textContent?.includes(label));
function rightClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
  });
}
function drag(el: Element, type: string) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: { setData: () => {}, effectAllowed: '' } });
  act(() => {
    el.dispatchEvent(ev);
  });
}

describe('the rail in groups', () => {
  it('Pinned on top (an older pinned one too), your sections in order — empty ones say what to do — then Other', () => {
    render();
    expect(shown()).toEqual(['# Pinned', 'feat/c', 'feat/old', '# Client X', 'feat/b', '# Waiting', '# Other', 'feat/a', 'feat/d']);
    expect(container.querySelector('.wd-dash-rail-group-empty')?.textContent).toContain('Move to “Waiting”');
  });

  it('nothing placed: no headings at all, as before', () => {
    render({ layout: { sections: [], places: {} } });
    expect(shown()).toEqual(['feat/a', 'feat/b', 'feat/c', 'feat/d']);
  });

  it('a heading folds its rows away (still showing the open one), remembered in this browser', () => {
    render({ activeSessionId: 'old' });
    act(() => heading('Pinned').click());
    expect(shown()).toEqual(['# Pinned', 'feat/old', '# Client X', 'feat/b', '# Waiting', '# Other', 'feat/a', 'feat/d']);
    expect(heading('Pinned').getAttribute('aria-expanded')).toBe('false');
    act(() => root.unmount());
    root = createRoot(container);
    render();
    expect(shown().slice(0, 2)).toEqual(['# Pinned', '# Client X']);
  });

  it('right-click a row: Pin to top, Move to each section, New section… names one and moves it there', async () => {
    const p = render();
    rightClick(row('feat/a'));
    expect([...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent)).toEqual(
      expect.arrayContaining(['Pin to top', 'Move to “Client X”', 'Move to “Waiting”', 'New section…']),
    );
    act(() => menuItem('Move to “Waiting”')!.click());
    expect(p.onPlace).toHaveBeenCalledWith('a', { pinned: false, section: 'y' });

    rightClick(row('feat/a'));
    act(() => menuItem('New section…')!.click());
    const input = container.querySelector<HTMLInputElement>('input[aria-label="New section name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Hotfixes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    const op = vi.mocked(p.onSections).mock.calls[0][0];
    expect(op).toMatchObject({ op: 'add', name: 'Hotfixes' }); // one change, not the whole list
    expect(p.onPlace).toHaveBeenLastCalledWith('a', { pinned: false, section: op.id });
  });

  it('dragging a row onto a heading moves it into that group', () => {
    const p = render();
    drag(row('feat/a').parentElement!, 'dragstart');
    const h = heading('Client X').parentElement!;
    drag(h, 'dragover');
    expect(h.className).toContain('wd-dash-rail-group-drop');
    drag(h, 'drop');
    expect(p.onPlace).toHaveBeenCalledWith('a', { pinned: false, section: 'x' });
    expect(p.onReorder).not.toHaveBeenCalled(); // a heading has no place among rows
  });

  it('dragging a row onto a row of another group: into that group, and in front of that row', () => {
    const p = render();
    drag(row('feat/a').parentElement!, 'dragstart');
    const target = row('feat/b').parentElement!; // in Client X
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect);
    const ev = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { setData: () => {}, effectAllowed: '' } });
      Object.defineProperty(e, 'clientY', { value: 5 });
      act(() => {
        target.dispatchEvent(e);
      });
    };
    ev('dragover');
    ev('drop');
    expect(p.onPlace).toHaveBeenCalledWith('a', { pinned: false, section: 'x' });
    expect(p.onReorder).toHaveBeenCalledWith(['c', 'old', 'a', 'b', 'd']);
  });

  it('a row dropped in its own group only moves (no place change)', () => {
    const p = render();
    drag(row('feat/d').parentElement!, 'dragstart');
    const target = row('feat/a').parentElement!;
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 40 } as DOMRect);
    for (const type of ['dragover', 'drop']) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { setData: () => {}, effectAllowed: '' } });
      Object.defineProperty(e, 'clientY', { value: 5 });
      act(() => {
        target.dispatchEvent(e);
      });
    }
    expect(p.onPlace).not.toHaveBeenCalled();
    expect(p.onReorder).toHaveBeenCalledWith(['c', 'old', 'b', 'd', 'a']);
  });

  it('with every row placed, Other stays, empty, as somewhere to drag a row out of its section', () => {
    render({
      sessions: [session('a'), session('b')],
      layout: { sections: [{ id: 'x', name: 'Client X' }], places: { a: { section: 'x' }, b: { pinned: true } } },
    });
    expect(shown()).toEqual(['# Pinned', 'feat/b', '# Client X', 'feat/a', '# Other']);
    expect(container.textContent).toContain('Drag a session here to unpin it or take it out of its section.');
  });

  it("a section's menu: rename, reorder, remove (its sessions stay, in the rest)", () => {
    const p = render();
    rightClick(heading('Client X'));
    act(() => menuItem('Move down')!.click());
    expect(p.onSections).toHaveBeenLastCalledWith({ op: 'move', id: 'x', by: 1 });
    rightClick(heading('Client X'));
    act(() => menuItem('Remove section')!.click());
    expect(p.onSections).toHaveBeenLastCalledWith({ op: 'remove', id: 'x' });
  });

  it('Alt+1…9 opens the rows as shown, pinned first — a terminal included, not while typing in a field', () => {
    const p = render();
    const alt = (code: string, target: EventTarget = window) =>
      act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(-1), altKey: true, bubbles: true, cancelable: true }));
      });
    alt('Digit1');
    expect(p.onSelect).toHaveBeenLastCalledWith('c');
    alt('Digit3');
    expect(p.onSelect).toHaveBeenLastCalledWith('b');
    alt('Digit9'); // no ninth row
    expect(p.onSelect).toHaveBeenCalledTimes(2);

    const term = document.createElement('textarea');
    term.className = 'xterm-helper-textarea';
    document.body.appendChild(term);
    term.focus();
    alt('Digit2', term);
    expect(p.onSelect).toHaveBeenLastCalledWith('old');
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    alt('Digit1', field);
    expect(p.onSelect).toHaveBeenCalledTimes(3);
    term.remove();
    field.remove();
  });
});

describe('the rows as shown (j/k walk them)', () => {
  it('reported on every change: older ones unfolded, a heading folded', () => {
    const more = [...SESSIONS, session('old2', old)];
    const onShownChange = vi.fn();
    render({ sessions: more, onShownChange });
    expect(onShownChange).toHaveBeenLastCalledWith(['c', 'old', 'b', 'a', 'd']);
    act(() =>
      [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-older')].find((b) => b.textContent?.includes('older'))!.click(),
    );
    expect(onShownChange).toHaveBeenLastCalledWith(['c', 'old', 'b', 'a', 'd', 'old2']);
    act(() => heading('Client X').click());
    expect(onShownChange).toHaveBeenLastCalledWith(['c', 'old', 'a', 'd', 'old2']);
  });
});

describe('the pure parts', () => {
  it('railMenuItems: Unpin for a pinned one; out of its own section instead of into it', () => {
    const labels = (id: string) => railMenuItems(session(id), LAYOUT, { place: () => {}, newSection: () => {} }).map((m) => m.label);
    expect(labels('c')[0]).toBe('Unpin');
    expect(labels('b')).toEqual(['Pin to top', 'Move to “Waiting”', 'Take out of “Client X”', 'New section…']);
  });

  it('railGroups (j/k walk this): pinned older ones and the open one are kept; the rest of the older ones are counted', () => {
    const more = [...SESSIONS, session('old2', old), session('old3', old)];
    const { groups, hidden } = railGroups(more, { layout: LAYOUT, activeId: 'old2' });
    expect(groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(['c', 'old', 'b', 'a', 'd', 'old2']);
    expect(hidden).toBe(1);
  });
});
