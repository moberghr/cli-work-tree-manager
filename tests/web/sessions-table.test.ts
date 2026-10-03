// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ setArchived: vi.fn(), openInTerminal: vi.fn() }));
/** The fake setArchived, through the in-flight store as the real one goes (archive-pending.ts). */
const trackedSetArchived = vi.hoisted(() => async () => {
  const { trackArchive } = await import('../../src/web/src/api/archive-pending.js');
  return { setArchived: (id: string, archived: boolean) => trackArchive(id, archived, h.setArchived(id, archived)) };
});
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  ...(await trackedSetArchived()),
}));
vi.mock('../../src/web/src/api/panes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/panes.js')>()),
  openInTerminal: h.openInTerminal,
}));

import { SessionsTab } from '../../src/web/src/components/Dashboard/tabs/SessionsTab.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.setArchived.mockReset().mockResolvedValue({ ok: true });
  h.openInTerminal.mockReset().mockResolvedValue({ ok: true });
  try {
    localStorage.clear();
  } catch {
    /* */
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const att = (state: SessionAttention['state'], seen: boolean, summary?: string): SessionAttention => ({
  state,
  seen,
  since: minsAgo(3),
  updatedAt: minsAgo(3),
  summary,
  stale: false,
});
const s = (over: Partial<SessionSummary> & { id: string }): SessionSummary => ({
  target: 'api',
  branch: over.id,
  isGroup: false,
  paths: [`/wt/${over.id}`],
  createdAt: minsAgo(1000),
  lastAccessedAt: minsAgo(10),
  activityState: 'stale',
  ...over,
});

const SESSIONS = [
  // Distinct access times: equal ones computed a moment apart made the
  // "recent" order depend on whether the clock ticked a millisecond between.
  s({
    id: 'blocked',
    lastAccessedAt: minsAgo(9),
    attention: att('needs_input', false, 'Needs Bash'),
    diffStat: { added: 4, deleted: 2, files: 1 },
  }),
  s({ id: 'done', attention: att('idle', false, 'Added tests') }),
  s({ id: 'working', attention: att('working', true, 'Refactoring') }),
  s({ id: 'old', lastAccessedAt: minsAgo(3 * 24 * 60) }), // days quiet: the Stale example
  s({ id: 'archived', archivedAt: minsAgo(60) }),
];

function render(onOpen = vi.fn(), onDelete = vi.fn()) {
  act(() =>
    root.render(
      createElement(SessionsTab, {
        sessions: SESSIONS,
        onOpenSession: onOpen,
        onNewWorktree: () => {},
        onDeleteSession: onDelete,
      }),
    ),
  );
  return { onOpen, onDelete };
}
const rows = () => [...container.querySelectorAll<HTMLTableRowElement>('tbody tr')];
/** View ▾ holds the table's filter, grouping, sort and checkboxes. */
const openView = () => act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'View ▾')!.click());
const viewCheck = (label: string) =>
  [...container.querySelectorAll<HTMLLabelElement>('.wd-view-menu-panel .wd-tab-check')]
    .find((l) => l.textContent?.includes(label))!
    .querySelector('input')!;
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('Sessions table', () => {
  it('five columns — status, session, summary, changes, active — and one status vocabulary', () => {
    try {
      localStorage.setItem('work-web:sessions-grouping', 'none');
    } catch {
      /* */
    } // one table
    render();
    expect([...container.querySelectorAll('thead th')].map((th) => text(th))).toEqual([
      'Status',
      'Session',
      'Summary',
      'Changes',
      'Active',
      'Actions', // the ⋯ column, named for screen readers
    ]);
    expect(text(container.querySelector('h1'))).toBe('Sessions 3 now · 1 this week');
    const first = rows().find((r) => text(r).includes('blocked'))!;
    expect(text(first.querySelector('.wd-st-status'))).toBe('Needs your input');
    expect(text(first.querySelector('.wd-st-col-summary'))).toBe('Needs Bash');
    expect(text(first.querySelector('.wd-st-col-changes'))).toBe('+4 −2');
    // No buttons on a row but its ⋯, and no checkboxes until you select several.
    expect([...first.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['⋯']);
    expect(container.querySelector('tbody input[type=checkbox]')).toBeNull();
  });

  it('a context badge only past 70%, and an overlap as a ⚠ with the files on hover', () => {
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [
            s({ id: 'full', context: { used: 168_000, window: 200_000 } }),
            s({ id: 'roomy', context: { used: 20_000, window: 200_000 } }),
            s({
              id: 'clash',
              overlaps: [{ sessionId: 'x', target: 'api', branch: 'feat/x', files: [{ repo: 'api', path: 'src/a.ts' }], count: 1 }],
            }),
          ],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
        }),
      ),
    );
    const row = (id: string) => rows().find((r) => text(r.querySelector('.wd-st-branch')) === id)!;
    expect(text(row('full').querySelector('.wd-st-full'))).toBe('84% full');
    expect(row('roomy').querySelector('.wd-st-full')).toBeNull();
    const warn = row('clash').querySelector<HTMLElement>('.wd-st-overlap')!;
    expect(warn.textContent).toBe('⚠');
    expect(warn.title).toContain('api/src/a.ts');
  });

  it('hides archived sessions until "Show archived" is on', () => {
    render();
    expect(rows().some((r) => text(r).includes('archived'))).toBe(false);
    openView();
    const toggle = viewCheck('Show archived');
    expect(text(toggle.parentElement)).toContain('Show archived (1)');
    act(() => toggle.click());
    const arch = rows().find((r) => r.className.includes('wd-session-row-archived'))!;
    expect(text(arch.querySelector('.wd-archived-pill'))).toBe('archived');
    // Its ⋯ offers Restore.
    act(() => arch.querySelector<HTMLButtonElement>('.wd-st-more')!.click());
    expect([...document.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toContain('Restore');
  });

  it('a row click opens the session where you would act on it', () => {
    const { onOpen } = render();
    act(() =>
      rows()
        .find((r) => text(r).includes('blocked'))!
        .click(),
    );
    act(() =>
      rows()
        .find((r) => text(r).includes('done'))!
        .click(),
    );
    expect(onOpen.mock.calls).toEqual([
      ['blocked', 'term'],
      ['done', 'diff'],
    ]);
  });

  it('⋯ (or a right-click) opens the row menu without opening the row; Archive shows progress in the row', async () => {
    let resolve!: (v: unknown) => void;
    h.setArchived.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { onOpen, onDelete } = render();
    const row = rows().find((r) => text(r).includes('working'))!;
    act(() => row.querySelector<HTMLButtonElement>('.wd-st-more')!.click());
    const item = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find((b) => b.textContent === label)!;
    act(() => item('Archive').click());
    expect(h.setArchived).toHaveBeenCalledWith('working', true);
    expect(text(row.querySelector('.wd-st-col-when'))).toBe('archiving…');
    await act(async () => resolve({ ok: true }));
    expect(text(row.querySelector('.wd-st-col-when'))).toBe('3m'); // its last status, 3 minutes ago
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    act(() => item('Delete…').click());
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'working' }));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('groups by age by default: Now, This week, and a "Show N older" link', () => {
    const old = {
      id: 'ancient',
      target: 'api',
      branch: 'ancient',
      isGroup: false,
      paths: ['/wt/ancient'],
      createdAt: minsAgo(99_999),
      lastAccessedAt: minsAgo(60 * 24 * 30),
      activityState: 'stale' as const,
    };
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [...SESSIONS, old],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
          onCleanUp: vi.fn(),
        }),
      ),
    );
    const headers = [...container.querySelectorAll('.wd-session-age h2 .wd-session-group-name')].map((h) => h.textContent);
    expect(headers).toEqual(['Now', 'This week']);
    expect(container.querySelector('.wd-session-age-older')).toBeNull();
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show 1 older')!.click());
    expect(container.querySelector('.wd-session-age-older table')?.textContent).toContain('ancient');
  });

  it('one table shown (the older folded away): no heading over it', () => {
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [s({ id: 'fresh' }), s({ id: 'ancient', lastAccessedAt: minsAgo(60 * 24 * 30) })],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector('.wd-session-group-header')).toBeNull();
    expect(text(container.querySelector('.wd-session-older'))).toBe('Show 1 older');
  });

  it('filters by bucket', () => {
    render();
    openView();
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Status filter"]')!;
    act(() => {
      select.value = 'needs';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Which rows, not their order (both fixtures' updates tie to the millisecond).
    expect(
      rows()
        .map((r) => text(r.querySelector('.wd-st-branch')))
        .sort(),
    ).toEqual(['blocked', 'done']);
  });
});

describe('Sessions tab search', () => {
  it('filters the table by text, and Esc clears it', () => {
    render();
    const box = container.querySelector<HTMLInputElement>('.wd-tab-search')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(box, 'work');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const branches = () => rows().map((r) => r.querySelector('.wd-st-branch')?.textContent ?? '');
    expect(rows()).toHaveLength(1);
    expect(branches()[0]).toContain('working');
    act(() => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(rows().length).toBeGreaterThan(1);
  });
});
