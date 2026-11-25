// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import type { RailLayout, SectionOp } from '../../src/core/rail/rail-layout.js';
import { SessionRail } from '../../src/web/src/components/Dashboard/SessionRail.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const now = new Date().toISOString();
const old = new Date(Date.now() - 60 * 24 * 3600_000).toISOString();
const attention = (state: 'needs_input' | 'working' | 'idle') =>
  ({ state, seen: true, since: now, updatedAt: now, stale: false }) as SessionSummary['attention'];
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    target: 'api',
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
    activityState: 'stale',
    pendingForClaudeCount: 0,
    attention: null,
    diffStat: null,
    archivedAt: null,
    port: null,
    ...extra,
  }) as SessionSummary;
const SESSIONS = [
  session('a'),
  session('b', { attention: attention('working') }),
  session('c', { attention: attention('needs_input') }),
  session('d', { replyDrafts: 1 }),
  session('e', { snoozed: { until: null }, replyDrafts: 2 }),
  session('old', { lastAccessedAt: old }),
];
const LAYOUT: RailLayout = {
  sections: [{ id: 'x', name: 'Client X' }],
  places: { c: { pinned: true }, d: { section: 'x', color: 'blue' } },
};
const MINE = ['# Pinned', 'feat/c', '# Client X', 'feat/d', '# Other', 'feat/a', 'feat/b', 'feat/e', '# Older'];
const STATE = ['# Needs you', 'feat/c', 'feat/d', '# Working', 'feat/b', '# Idle', 'feat/a', '# Snoozed', 'feat/e', '# Older'];

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
  // The stored view must not reach the other rail tests.
  localStorage.clear();
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
function remount(over: Partial<Parameters<typeof SessionRail>[0]> = {}) {
  act(() => root.unmount());
  root = createRoot(container);
  return render(over);
}
/** The list as shown: headings as `# name`, rows by branch. */
const shown = () =>
  [...container.querySelectorAll('.wd-dash-rail-group-name, .wd-dash-rail-name')].map((n) =>
    n.classList.contains('wd-dash-rail-group-name') ? `# ${n.textContent}` : n.textContent,
  );
const counts = () =>
  [...container.querySelectorAll('.wd-dash-rail-group-toggle')].map(
    (b) => `${b.querySelector('.wd-dash-rail-group-name')!.textContent} ${b.querySelector('.wd-dash-rail-group-count')!.textContent}`,
  );
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === label)!;
const choose = (label: string) => act(() => tab(label).click());
const heading = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-group-toggle')].find(
    (b) => b.querySelector('.wd-dash-rail-group-name')?.textContent === name,
  )!;
const row = (branch: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-item')].find(
    (b) => b.querySelector('.wd-dash-rail-name')?.textContent === branch,
  )!;
const menuLabels = () => [...document.querySelectorAll('[role="menuitem"]')].map((m) => m.textContent);
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

describe('the rail’s view switch', () => {
  it('Mine · State in the header, before the legend and +, Mine on at first: the rail as it was', () => {
    render();
    const header = container.querySelector('.wd-dash-rail-header')!;
    const list = header.querySelector('[role="tablist"]')!;
    expect(list.classList).toContain('wd-segmented');
    expect([...list.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Mine', 'State']);
    expect(header.firstElementChild).toBe(list);
    expect(list.compareDocumentPosition(header.querySelector('.wd-legend')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tab('Mine').getAttribute('aria-selected')).toBe('true');
    expect(shown()).toEqual(MINE);
  });

  it('State: the same rows under Needs you, Working, Idle, Snoozed, Older, each with its count; remembered on reload', () => {
    render();
    choose('State');
    expect(tab('State').getAttribute('aria-selected')).toBe('true');
    expect(shown()).toEqual(STATE);
    expect(counts()).toEqual(['Needs you 2', 'Working 1', 'Idle 1', 'Snoozed 1', 'Older 1']);
    expect(localStorage.getItem('work-web:rail-view')).toBe('state');

    remount();
    expect(tab('State').getAttribute('aria-selected')).toBe('true');
    expect(shown()).toEqual(STATE);
    choose('Mine');
    expect(shown()).toEqual(MINE);
    expect(localStorage.getItem('work-web:rail-view')).toBe('mine');
  });

  it('switching changes only the grouping: every row drawn the same, its color bar too', () => {
    render();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    // A spinner's phase follows the clock (so every spinner turns together): not part of the row's shape.
    const markup = () =>
      Object.fromEntries(ids.map((id) => [id, row(`feat/${id}`).innerHTML.replace(/ style="animation-delay: -?\d+ms;"/g, '')]));
    const before = markup();
    choose('State');
    expect(markup()).toEqual(before);
    expect(row('feat/d').closest('li')!.className).toContain('wd-dash-rail-colored wd-tag-blue');
  });
});

describe('State is read-only for placement', () => {
  it('no row is draggable, and a drag onto a heading or a row places and reorders nothing', () => {
    const p = render();
    choose('State');
    const rows = [...container.querySelectorAll('.wd-dash-rail-item')].map((b) => b.closest('li')!);
    expect(rows.length).toBe(5);
    for (const li of rows) expect(li.getAttribute('draggable')).toBe('false');

    drag(row('feat/a').closest('li')!, 'dragstart');
    expect(row('feat/a').closest('li')!.className).not.toContain('wd-dash-rail-dragging');
    const h = heading('Working').closest('li')!;
    drag(h, 'dragover');
    expect(h.className).not.toContain('wd-dash-rail-group-drop');
    drag(h, 'drop');
    const target = row('feat/b').closest('li')!;
    drag(target, 'dragover');
    drag(target, 'drop');
    expect(p.onPlace).not.toHaveBeenCalled();
    expect(p.onReorder).not.toHaveBeenCalled();
  });

  it('Alt+↑/↓ moves nothing; a heading has no menu, and there are no empty-group hints', () => {
    const p = render();
    choose('State');
    act(() => {
      row('feat/b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    });
    expect(p.onReorder).not.toHaveBeenCalled();
    rightClick(heading('Needs you'));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('.wd-dash-rail-group-empty')).toBeNull();
  });

  it('a row’s right-click menu is unchanged: Pin and Move to change Mine', () => {
    const p = render();
    choose('State');
    rightClick(row('feat/a'));
    expect(menuLabels()).toEqual(expect.arrayContaining(['Pin to top', 'Move to “Client X”', 'New section…']));
    act(() => menuItem('Pin to top')!.click());
    expect(p.onPlace).toHaveBeenCalledWith('a', { pinned: true });
    expect(shown()).toEqual(STATE); // still grouped by state
  });

  it('New section… from a row in State names it in Mine, where the section shows', () => {
    render();
    choose('State');
    rightClick(row('feat/a'));
    act(() => menuItem('New section…')!.click());
    expect(tab('Mine').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('input[aria-label="New section name"]')).not.toBeNull();
  });
});

describe('folding and the keyboard in State', () => {
  it('a State heading folds (the open row stays), remembered apart from Mine’s headings', () => {
    render({ activeSessionId: 'c' });
    choose('State');
    act(() => heading('Needs you').click());
    act(() => heading('Idle').click());
    expect(shown()).toEqual(['# Needs you', 'feat/c', '# Working', 'feat/b', '# Idle', '# Snoozed', 'feat/e', '# Older']);

    choose('Mine');
    expect(shown()).toEqual(MINE); // nothing of Mine's folded
    act(() => heading('Other').click());
    choose('State');
    expect(shown()).toEqual(['# Needs you', 'feat/c', '# Working', 'feat/b', '# Idle', '# Snoozed', 'feat/e', '# Older']);

    remount({ activeSessionId: 'c' });
    expect(heading('Idle').getAttribute('aria-expanded')).toBe('false');
    expect(heading('Working').getAttribute('aria-expanded')).toBe('true');
  });

  it('Alt+1…9 and the rows reported for j/k follow State’s rows', () => {
    const onShownChange = vi.fn();
    const p = render({ onShownChange });
    expect(onShownChange).toHaveBeenLastCalledWith(['c', 'd', 'a', 'b', 'e']);
    choose('State');
    expect(onShownChange).toHaveBeenLastCalledWith(['c', 'd', 'b', 'a', 'e']);
    const alt = (code: string) =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(-1), altKey: true, bubbles: true, cancelable: true }));
      });
    alt('Digit3');
    expect(p.onSelect).toHaveBeenLastCalledWith('b');
    alt('Digit4');
    expect(p.onSelect).toHaveBeenLastCalledWith('a');
    expect(row('feat/b').title).toContain('Alt+3');
  });
});
