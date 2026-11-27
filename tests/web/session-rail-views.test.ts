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
/** A heading's name: a group's, or a Project card's (its own button). */
const HEADING_NAME = '.wd-dash-rail-group-name, .wd-rail-pcard-name';
/** The list as shown: headings as `# name`, rows by branch. */
const shown = () =>
  [...container.querySelectorAll(`${HEADING_NAME}, .wd-dash-rail-name`)].map((n) =>
    n.classList.contains('wd-dash-rail-name') ? n.textContent : `# ${n.textContent}`,
  );
const counts = () =>
  [...container.querySelectorAll('li.wd-dash-rail-group')].map(
    (li) => `${li.querySelector(HEADING_NAME)!.textContent} ${li.querySelector('.wd-dash-rail-group-count')!.textContent}`,
  );
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === label)!;
const choose = (label: string) => act(() => tab(label).click());
/** A heading's fold button, by its name. */
const heading = (name: string) =>
  [...container.querySelectorAll('li.wd-dash-rail-group')]
    .find((li) => li.querySelector(HEADING_NAME)?.textContent === name)!
    .querySelector<HTMLButtonElement>('.wd-dash-rail-group-toggle')!;
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
  // Reported: the three labels ran past a narrow rail's edge. There, one button names the view and opens a menu (rail.css).
  it('a narrow rail’s button: names the view, opens a menu of the three with the one on checked, and switches', () => {
    render();
    const pick = container.querySelector<HTMLButtonElement>('.wd-dash-rail-view-pick')!;
    expect(pick.textContent).toContain('Mine');
    expect(pick.getAttribute('aria-haspopup')).toBe('menu');
    act(() => pick.click());
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Mine'),
      expect.stringContaining('State'),
      expect.stringContaining('Project'),
    ]);
    expect(items[0].getAttribute('aria-checked')).toBe('true');
    act(() => items[2].click());
    expect(localStorage.getItem('work-web:rail-view')).toBe('project');
    expect(container.querySelector('.wd-dash-rail-view-pick')!.textContent).toContain('Project');
    expect(tab('Project').getAttribute('aria-selected')).toBe('true');
  });

  it('Mine · State · Project in the header, before the legend and +, Mine on at first: the rail as it was', () => {
    render();
    const header = container.querySelector('.wd-dash-rail-header')!;
    const list = header.querySelector('[role="tablist"]')!;
    expect(list.classList).toContain('wd-segmented');
    expect([...list.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Mine', 'State', 'Project']);
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

describe('the Project view', () => {
  const PROJECTS = [
    session('a'),
    session('w', { target: 'web', replyDrafts: 1 }),
    session('b', { attention: attention('working') }),
    session('named', { target: 'web', title: 'Checkout rework', titleIsYours: true, keepAfterMerge: true }),
    session('old', { lastAccessedAt: old }),
  ];
  const project = (over: Partial<Parameters<typeof SessionRail>[0]> = {}) => {
    const props = render({ sessions: PROJECTS, ...over });
    choose('Project');
    return props;
  };
  const card = () => document.querySelector('.wd-rail-card');

  it('a heading per project with its count, then Older; remembered', () => {
    project();
    expect(shown()).toEqual(['# api', 'feat/a', 'feat/b', '# web', 'feat/w', 'Checkout rework', '# Older']);
    expect(counts()).toEqual(['api 2', 'web 2', 'Older 1']);
    expect(localStorage.getItem('work-web:rail-view')).toBe('project');
    remount({ sessions: PROJECTS });
    expect(tab('Project').getAttribute('aria-selected')).toBe('true');
  });

  it('a heading’s + opens New worktree with its project; Older has none; the header’s + passes no project', () => {
    const onNewWorktree = vi.fn();
    project({ onNewWorktree });
    const adds = [...container.querySelectorAll<HTMLButtonElement>('.wd-dash-rail-group-add')];
    expect(adds.map((b) => b.getAttribute('aria-label'))).toEqual(['New worktree in api', 'New worktree in web']);
    act(() => adds[1].click());
    expect(onNewWorktree).toHaveBeenLastCalledWith('web');
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="New worktree"]')!.click());
    expect(onNewWorktree).toHaveBeenLastCalledWith();
  });

  it('no + on a heading in Mine or State', () => {
    render({ sessions: PROJECTS });
    expect(container.querySelector('.wd-dash-rail-group-add')).toBeNull();
    choose('State');
    expect(container.querySelector('.wd-dash-rail-group-add')).toBeNull();
  });

  it('a row is one line: no project text, no keep, no tooltip; its status and time are still on it', () => {
    project();
    const r = row('feat/w');
    expect(r.querySelectorAll('.wd-dash-rail-line')).toHaveLength(1);
    expect(r.querySelector('.wd-dash-rail-summary')).toBeNull();
    expect(r.getAttribute('title')).toBeNull();
    expect(r.querySelector('.wd-dash-rail-status-pill')).not.toBeNull();
    expect(r.querySelector('.wd-dash-rail-slot')).not.toBeNull();
    expect(row('Checkout rework').querySelector('.wd-rail-keep')).toBeNull();
    choose('Mine');
    expect(row('feat/w').querySelectorAll('.wd-dash-rail-line')).toHaveLength(2);
    expect(row('feat/w').getAttribute('title')).toContain('web · feat/w');
  });

  it('hovering a row shows its card after a wait; leaving takes it away', () => {
    vi.useFakeTimers();
    try {
      project();
      const r = row('Checkout rework');
      act(() => {
        r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(card()).toBeNull();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(card()!.getAttribute('role')).toBe('tooltip');
      expect(card()!.querySelector('.wd-rail-card-name')!.textContent).toBe('Checkout rework');
      expect(card()!.querySelector('.wd-rail-card-where')!.textContent).toBe('web · feat/named');
      expect(card()!.textContent).toContain('kept after its PR merges');
      expect(r.getAttribute('aria-describedby')).toBe(card()!.id);
      act(() => {
        r.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a pointer that only passes over a row shows no card', () => {
    vi.useFakeTimers();
    try {
      project();
      const r = row('feat/a');
      act(() => {
        r.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.advanceTimersByTime(100);
        r.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        vi.advanceTimersByTime(1000);
      });
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the card goes on a click and when the view changes; Mine and State show none', () => {
    vi.useFakeTimers();
    try {
      const props = project();
      const hover = (branch: string) =>
        act(() => {
          row(branch).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          vi.advanceTimersByTime(400);
        });
      hover('feat/a');
      expect(card()).not.toBeNull();
      act(() => row('feat/a').click());
      expect(card()).toBeNull();
      expect(props.onSelect).toHaveBeenCalledWith('a');
      hover('feat/a');
      expect(card()).not.toBeNull();
      choose('State');
      // Back in Project the card left behind must not come back by itself.
      choose('Project');
      expect(card()).toBeNull();
      choose('State');
      hover('feat/a');
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the card lists a PR with its title and stage', () => {
    vi.useFakeTimers();
    try {
      const prs = [{ number: 12, title: 'Retry webhooks', repoAlias: 'api', branch: 'feat/a', url: 'https://x/12', isDraft: true }];
      project({ prsFor: ((s: SessionSummary) => (s.id === 'a' ? prs : [])) as never });
      act(() => {
        row('feat/a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.advanceTimersByTime(400);
      });
      const pr = card()!.querySelector('.wd-rail-card-prs li')!;
      expect(pr.querySelector('.wd-rail-card-pr-ref')!.textContent).toBe('api #12');
      expect(pr.querySelector('.wd-rail-card-pr-title')!.textContent).toBe('Retry webhooks');
      expect(pr.querySelector('.wd-rail-card-pr-stage')!.textContent).toBe('draft');
    } finally {
      vi.useRealTimers();
    }
  });

  const hoverNow = (branch: string) =>
    act(() => {
      row(branch).dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      vi.advanceTimersByTime(400);
    });

  /** jsdom never says a focus came from the keyboard: say so for the rows, as a browser does after Tab. */
  const keyboardFocus = (yes = true) => {
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? yes : matches.call(this, sel);
    });
  };
  afterEach(() => vi.restoreAllMocks());

  it('a focus that is not the keyboard’s (a click’s) shows no card', () => {
    keyboardFocus(false);
    project();
    act(() => row('feat/b').focus());
    expect(card()).toBeNull();
  });

  it('keyboard focus shows the card at once; blur takes it away', () => {
    keyboardFocus();
    project();
    act(() => row('feat/b').focus());
    expect(card()!.querySelector('.wd-rail-card-name')!.textContent).toBe('feat/b');
    act(() => row('feat/b').blur());
    expect(card()).toBeNull();
  });

  it('Esc, a right-click, a scroll of the list and F2 each take the card away', () => {
    vi.useFakeTimers();
    try {
      project({ onRename: vi.fn(async () => {}) });
      hoverNow('feat/a');
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(card()).toBeNull();
      hoverNow('feat/b');
      rightClick(row('feat/b'));
      expect(card()).toBeNull();
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      hoverNow('feat/a');
      act(() => {
        container.querySelector('.wd-dash-rail-list')!.dispatchEvent(new Event('scroll'));
      });
      expect(card()).toBeNull();
      hoverNow('feat/a');
      expect(card()).not.toBeNull();
      act(() => {
        row('feat/a').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      });
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a scroll before the wait is over: no card for the row that moved away', () => {
    vi.useFakeTimers();
    try {
      project();
      act(() => {
        row('feat/a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.advanceTimersByTime(100);
        container.querySelector('.wd-dash-rail-list')!.dispatchEvent(new Event('scroll'));
        vi.advanceTimersByTime(1000);
      });
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the card goes when the rows change under it', () => {
    vi.useFakeTimers();
    try {
      project();
      hoverNow('feat/b');
      expect(card()).not.toBeNull();
      render({ sessions: PROJECTS.filter((s) => s.id !== 'a') });
      expect(card()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaving a hovered row keeps the focused row’s card', () => {
    vi.useFakeTimers();
    try {
      keyboardFocus();
      project();
      act(() => row('feat/b').focus());
      act(() => {
        row('feat/a').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.advanceTimersByTime(100);
        row('feat/a').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      expect(card()!.querySelector('.wd-rail-card-name')!.textContent).toBe('feat/b');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the card says what the tooltip does: behind, stacked on, the automatic title, what you owe; snoozed once', () => {
    vi.useFakeTimers();
    try {
      const sessions = [
        session('x', {
          title: 'Add retries to webhooks',
          stackedOn: { id: 'a', branch: 'feat/a' },
          replyDrafts: 1,
          snoozed: { until: null },
        }),
        session('a'),
      ];
      render({ sessions });
      choose('Project');
      hoverNow('feat/x');
      const text = card()!.textContent!;
      expect(text).toContain('stacked on feat/a');
      expect(text).toContain('Add retries to webhooks');
      expect(text).toContain('reply');
      expect(text.match(/snoozed/gi)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a project heading folds by itself, remembered', () => {
    project();
    act(() => heading('api').click());
    expect(shown()).toEqual(['# api', '# web', 'feat/w', 'Checkout rework', '# Older']);
    remount({ sessions: PROJECTS });
    expect(shown()).toEqual(['# api', '# web', 'feat/w', 'Checkout rework', '# Older']);
  });

  it('nothing is dragged or placed in Project', () => {
    const props = project();
    expect(row('feat/a').closest('li')!.draggable).toBe(false);
    drag(row('feat/a').closest('li')!, 'dragstart');
    drag(heading('web').closest('li')!, 'dragover');
    drag(container.querySelector('.wd-dash-rail-list')!, 'drop');
    expect(props.onPlace).not.toHaveBeenCalled();
    expect(props.onReorder).not.toHaveBeenCalled();
  });

  // Asked for (the mockups' A): each project a card, its own checkout first, its name opening it, its color its edge.
  it('each project a card: its heading the top, its rows the rest, the last row closing it; Older is no card', () => {
    project();
    const pieces = (name: string) => {
      const head = [...container.querySelectorAll('li.wd-dash-rail-group')].find(
        (li) => li.querySelector(HEADING_NAME)?.textContent === name,
      )!;
      const out = [head];
      for (let n = head.nextElementSibling; n && !n.classList.contains('wd-dash-rail-group'); n = n.nextElementSibling) out.push(n);
      return out.map((li) => [...li.classList].filter((c) => c.startsWith('wd-rail-pcard')).join(' '));
    };
    expect(pieces('api')).toEqual(['wd-rail-pcard wd-rail-pcard-head', 'wd-rail-pcard', 'wd-rail-pcard wd-rail-pcard-end']);
    const older = [...container.querySelectorAll('li.wd-dash-rail-group')].find((li) => li.textContent?.includes('Older'))!;
    expect(older.classList.contains('wd-rail-pcard')).toBe(false);
    // Folded: the heading closes the card itself.
    act(() => heading('api').click());
    expect(pieces('api')).toEqual(['wd-rail-pcard wd-rail-pcard-head wd-rail-pcard-end']);
  });

  it("its own checkout first, marked; the card's name opens it (no own checkout: the name folds)", () => {
    const base = session('main', {
      target: 'api',
      branch: 'main',
      baseCheckout: true,
      lastAccessedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const props = project({ sessions: [...PROJECTS, base] });
    expect(shown().slice(0, 4)).toEqual(['# api', 'main', 'feat/a', 'feat/b']);
    expect(row('main').querySelector('.wd-rail-home')).not.toBeNull();
    expect(row('feat/a').querySelector('.wd-rail-home')).toBeNull();
    const name = (n: string) => [...container.querySelectorAll<HTMLButtonElement>('.wd-rail-pcard-name')].find((b) => b.textContent === n)!;
    expect(name('api').title).toBe("Open api's own checkout (main)");
    act(() => name('api').click());
    expect(props.onSelect).toHaveBeenLastCalledWith('main');
    act(() => name('web').click());
    expect(shown()).not.toContain('feat/w');
  });

  it("the project's color is the card's edge; a row draws a bar only for a color of its own", () => {
    project({
      layout: { sections: [], places: { a: { color: 'purple' }, b: { color: 'orange' } }, projectColors: { api: 'orange' } },
    });
    const api = [...container.querySelectorAll<HTMLElement>('li.wd-dash-rail-group')].find(
      (li) => li.querySelector(HEADING_NAME)?.textContent === 'api',
    )!;
    expect(api.style.getPropertyValue('--rail-pcard')).toBe('var(--tag-orange)');
    expect(row('feat/a').closest('li')!.className).toContain('wd-tag-purple');
    // The project's own color again: the card says it, no bar.
    expect(row('feat/b').closest('li')!.className).not.toContain('wd-dash-rail-colored');
    expect(row('feat/b').closest('li')!.style.getPropertyValue('--rail-pcard')).toBe('var(--tag-orange)');
    // No color: a plain card.
    const web = [...container.querySelectorAll<HTMLElement>('li.wd-dash-rail-group')].find(
      (li) => li.querySelector(HEADING_NAME)?.textContent === 'web',
    )!;
    expect(web.style.getPropertyValue('--rail-pcard')).toBe('');
    // Mine keeps a bar per row, the project's color too.
    choose('Mine');
    expect(row('feat/b').closest('li')!.className).toContain('wd-dash-rail-colored');
  });

  it('Alt+1…9 follows Project’s rows', () => {
    const props = project();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3', altKey: true, bubbles: true }));
    });
    expect(props.onSelect).toHaveBeenCalledWith('w');
  });
});
