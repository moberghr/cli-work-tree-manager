// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ setArchived: vi.fn(), openInTerminal: vi.fn(), search: vi.fn() }));
/** The fake setArchived, through the in-flight store as the real one goes (archive-pending.ts). */
const trackedSetArchived = vi.hoisted(() => async () => {
  const { trackArchive } = await import('../../src/web/src/api/archive-pending.js');
  return { setArchived: (id: string, archived: boolean) => trackArchive(id, archived, h.setArchived(id, archived)) };
});
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  ...(await trackedSetArchived()),
  searchConversations: (q: string) => h.search(q),
}));
vi.mock('../../src/web/src/api/panes.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/panes.js')>()),
  openInTerminal: h.openInTerminal,
}));

import { hitsInScope, SessionsTab } from '../../src/web/src/components/Dashboard/tabs/SessionsTab.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.setArchived.mockReset().mockResolvedValue({ ok: true });
  h.openInTerminal.mockReset().mockResolvedValue({ ok: true });
  h.search.mockReset().mockResolvedValue([]);
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
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('Sessions table', () => {
  it('six columns — status, session, project, summary, changes, active — and one status vocabulary', () => {
    try {
      localStorage.setItem('work-web:sessions-grouping', 'none');
    } catch {
      /* */
    } // one table
    render();
    expect([...container.querySelectorAll('thead th')].map((th) => text(th))).toEqual([
      'Status',
      'Session',
      'Project',
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

  const scopeBtn = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>('[aria-label="Which sessions"] button')].find((b) =>
      b.textContent?.startsWith(label),
    )!;

  it('Live / Archived / All in the header: Archived lists only the archived ones, each with Restore on its row', () => {
    const onShowArchived = vi.fn();
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: SESSIONS,
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
          onShowArchived,
        }),
      ),
    );
    expect(rows().some((r) => r.className.includes('wd-session-row-archived'))).toBe(false);
    expect(onShowArchived).toHaveBeenLastCalledWith(false); // not fetched until asked for

    act(() => scopeBtn('Archived').click());
    expect(onShowArchived).toHaveBeenLastCalledWith(true);
    expect(rows().map((r) => text(r.querySelector('.wd-st-branch')))).toEqual(['archived']);
    expect(text(container.querySelector('h1'))).toContain('1 archived');
    const arch = rows()[0];
    expect(text(arch.querySelector('.wd-archived-pill'))).toBe('archived');
    // In the Archived view the time column is when it was archived (an hour ago), not when it was last active.
    expect(text([...container.querySelectorAll('thead th')].find((th) => th.className === 'wd-st-col-when'))).toBe('Archived');
    expect(text(arch.querySelector('.wd-st-col-when'))).toBe('1h');
    expect(arch.querySelector('.wd-st-col-when')!.getAttribute('title')).toMatch(/^Archived .+\. Last active 10m ago\.$/);
    // All: the column is "Active", and an archived row shows its last activity there, as the header says.
    act(() => scopeBtn('All').click());
    expect(text([...container.querySelectorAll('thead th')].find((th) => th.className === 'wd-st-col-when'))).toBe('Active');
    const inAll = rows().find((r) => text(r.querySelector('.wd-st-branch')) === 'archived')!;
    expect(text(inAll.querySelector('.wd-st-col-when'))).toBe('10m');
    act(() => scopeBtn('Archived').click());
    act(() => arch.querySelector<HTMLButtonElement>('.wd-st-restore')!.click());
    expect(h.setArchived).toHaveBeenCalledWith('archived', false);
    // Its ⋯ offers Restore too.
    act(() => arch.querySelector<HTMLButtonElement>('.wd-st-more')!.click());
    expect([...document.querySelectorAll('[role=menuitem]')].map((b) => b.textContent)).toContain('Restore');

    act(() => scopeBtn('All').click());
    expect(rows()).toHaveLength(SESSIONS.length);
    expect(localStorage.getItem('work-web:sessions-show-archived')).toBe('all'); // remembered
  });

  it('Archived says Loading until the archived rows have come, never "none" first', () => {
    localStorage.setItem('work-web:sessions-show-archived', 'archived');
    const props = {
      sessions: SESSIONS.filter((x) => !x.archivedAt),
      onOpenSession: vi.fn(),
      onNewWorktree: () => {},
      onDeleteSession: vi.fn(),
    };
    act(() => root.render(createElement(SessionsTab, { ...props, archivedLoaded: false })));
    expect(text(container.querySelector('.wd-tab-empty'))).toBe('Loading archived sessions…');
    act(() => root.render(createElement(SessionsTab, { ...props, archivedLoaded: true })));
    expect(text(container.querySelector('.wd-tab-empty'))).toBe('No archived sessions.');
  });

  it('the Archived view lists old ones too (nothing folded under "Show N older")', () => {
    localStorage.setItem('work-web:sessions-show-archived', 'archived');
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [s({ id: 'long-ago', archivedAt: minsAgo(60 * 24 * 40), lastAccessedAt: minsAgo(60 * 24 * 40) })],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
        }),
      ),
    );
    expect(rows().map((r) => text(r.querySelector('.wd-st-branch')))).toEqual(['long-ago']);
  });

  it('an archived row says who archived it: you, Ship, its merged PR, or Clean up', () => {
    const by = (id: string, who: 'you' | 'shipped' | 'pr-merged' | 'cleanup' | undefined) =>
      s({
        id,
        archivedAt: minsAgo(60),
        archive: {
          ...(who ? { by: who } : {}),
          worktreeRemoved: who === 'pr-merged',
          keptBecause: null,
          promptCount: 0,
          prompts: [],
          lastSummary: null,
        },
      });
    localStorage.setItem('work-web:sessions-show-archived', 'archived');
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [by('a1', 'you'), by('a2', 'pr-merged'), by('a3', 'shipped'), by('a4', 'cleanup'), by('a5', undefined)],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
        }),
      ),
    );
    const pill = (id: string) =>
      rows()
        .find((r) => text(r.querySelector('.wd-st-branch')) === id)!
        .querySelector('.wd-archived-pill')!;
    expect(text(pill('a1'))).toBe('archived · by you');
    expect(text(pill('a2'))).toBe('archived · PR merged · folder removed');
    expect(pill('a2').getAttribute('title')).toContain('its pull request merged, so work archived it');
    expect(text(pill('a3'))).toBe('archived · merged with Ship');
    expect(text(pill('a4'))).toBe('archived · Clean up');
    expect(text(pill('a5'))).toBe('archived'); // archived before work recorded who
  });

  it('the Archived view is in the order its time column shows: archived most recently first', () => {
    localStorage.setItem('work-web:sessions-show-archived', 'archived');
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [
            // Active more recently, archived long ago — and the other way round.
            s({ id: 'archived-long-ago', lastAccessedAt: minsAgo(60), archivedAt: minsAgo(5 * 24 * 60) }),
            s({ id: 'archived-just-now', lastAccessedAt: minsAgo(2 * 24 * 60), archivedAt: minsAgo(30) }),
          ],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
        }),
      ),
    );
    expect(rows().map((r) => text(r.querySelector('.wd-st-branch')))).toEqual(['archived-just-now', 'archived-long-ago']);
    expect(rows().map((r) => text(r.querySelector('.wd-st-col-when')))).toEqual(['30m', '5d']);
    // Its sections are by archive time too: the one archived just now is under Now, though quiet for two days.
    expect([...container.querySelectorAll('.wd-session-age')].map((g) => text(g.querySelector('.wd-session-group-name')))).toEqual([
      'Now',
      'This week',
    ]);
    expect(text(container.querySelector('.wd-session-age-now .wd-st-branch'))).toBe('archived-just-now');
  });

  it('a "Show archived" tick from before reads as All; the project and a group are their own column', () => {
    localStorage.setItem('work-web:sessions-show-archived', '1');
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [...SESSIONS, s({ id: 'grp-work', target: 'shop', isGroup: true, paths: ['/wt/shop/a/api', '/wt/shop/a/web'] })],
          onOpenSession: vi.fn(),
          onNewWorktree: () => {},
          onDeleteSession: vi.fn(),
        }),
      ),
    );
    expect(scopeBtn('All').getAttribute('aria-pressed')).toBe('true');
    const grp = rows().find((r) => text(r.querySelector('.wd-st-branch')) === 'grp-work')!;
    expect(text(grp.querySelector('.wd-st-col-project'))).toBe('shop group');
    expect(text(grp.querySelector('.wd-st-session'))).toBe('grp-work');
  });

  it('a row click opens the session on its terminal, finished work too', () => {
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
      ['done', 'term'],
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
  it('the table and the conversation hits are in one scroller, so the hits never squeeze the table away', async () => {
    vi.useFakeTimers();
    try {
      h.search.mockResolvedValue([
        {
          sessionId: 'x',
          target: 'api',
          branch: 'feat/x',
          archived: false,
          archivedAt: null,
          worktreeRemoved: false,
          lastAt: null,
          snippets: [],
        },
      ]);
      render();
      const box = container.querySelector<HTMLInputElement>('.wd-tab-search')!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => {
        setValue.call(box, 'work');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      const scroller = container.querySelector('.wd-session-scroll')!;
      expect(scroller.querySelector('.wd-archive-hits')).not.toBeNull();
      expect(scroller.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Archived lists only archived conversations; Live and All every one', () => {
    const hits = [{ archived: true }, { archived: false }];
    expect(hitsInScope(hits, 'archived')).toEqual([{ archived: true }]);
    expect(hitsInScope(hits, 'live')).toBe(hits);
    expect(hitsInScope(hits, 'all')).toBe(hits);
  });

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

  it('a Restore refused from the conversation results says why, under that result (it used to say nothing)', async () => {
    vi.useFakeTimers();
    try {
      h.search.mockResolvedValue([
        {
          sessionId: 'old',
          target: 'api',
          branch: 'tmp/report-fail',
          archived: true,
          archivedAt: minsAgo(60),
          worktreeRemoved: true,
          snippets: [],
        },
      ]);
      const why =
        "Couldn't restore it: C:/wt/tmp-report-fail is what's left of its worktree, and a file in it is in use (Visual Studio, an editor, a terminal?): close it and try again";
      h.setArchived.mockRejectedValue(new Error(why));
      render();
      const box = container.querySelector<HTMLInputElement>('.wd-tab-search')!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => {
        setValue.call(box, 'report');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      const restore = [...container.querySelectorAll<HTMLButtonElement>('.wd-archive-hit button')].find(
        (b) => b.textContent === 'Restore',
      )!;
      await act(async () => {
        restore.click();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(container.querySelector('.wd-archive-hit-error')!.textContent).toBe(why);
      expect(container.querySelector('.wd-archive-hit-error')!.getAttribute('role')).toBe('alert');
      // Another search: the old refusal isn't shown again under a later result for the same session.
      act(() => {
        setValue.call(box, 'reports');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(container.querySelector('.wd-archive-hit-error')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
