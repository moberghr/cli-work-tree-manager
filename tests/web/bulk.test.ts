// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { bulkSummary, runBulk } from '../../src/web/src/state/bulk.js';
import { SessionsTab } from '../../src/web/src/components/Dashboard/tabs/SessionsTab.js';
import type { BulkActions } from '../../src/web/src/components/Dashboard/tabs/BulkBar.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('runBulk / bulkSummary', () => {
  it('a few at a time, every result in order, a failure doesn’t stop the rest', async () => {
    let running = 0;
    let most = 0;
    const progress: number[] = [];
    const results = await runBulk(['a', 'b', 'c', 'd', 'e'], async (id) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      if (id === 'c') throw new Error('1 uncommitted file');
    }, { concurrency: 2, onProgress: (d) => progress.push(d) });
    expect(most).toBe(2);
    expect(results.map((r) => [r.id, r.ok])).toEqual([['a', true], ['b', true], ['c', false], ['d', true], ['e', true]]);
    expect(progress).toEqual([1, 2, 3, 4, 5]);
    expect(bulkSummary('Archived', results, (id) => `feat/${id}`)).toBe('Archived 4; 1 refused: feat/c — 1 uncommitted file');
    expect(bulkSummary('Snoozed', results.filter((r) => r.ok), String)).toBe('Snoozed 4.');
  });
});

const now = new Date().toISOString();
const session = (id: string, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id, target: 'api', branch: `feat/${id}`, isGroup: false, paths: [`C:\\wt\\${id}`], createdAt: now, lastAccessedAt: now,
    draftCount: 0, commentCount: 0, claudeCount: 0, ptyStatus: 'idle', lastActivity: null, activityState: 'stale',
    pendingForClaudeCount: 0, attention: null, diffStat: null, archivedAt: null, port: null, ...extra,
  }) as SessionSummary;

describe('the Sessions table’s bulk bar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let bulk: { [K in keyof BulkActions]: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('work-web:sessions-grouping', 'none'); // one table
    localStorage.setItem('work-web:sessions-show-archived', '1');
    bulk = {
      archive: vi.fn(async (s: SessionSummary) => { if (s.id === 'b') throw new Error('its Claude is working'); }),
      restore: vi.fn(async () => {}),
      snooze: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() =>
      root.render(
        createElement(SessionsTab, {
          sessions: [session('a'), session('b'), session('c'), session('z', { archivedAt: now })],
          onOpenSession: () => {},
          onNewWorktree: () => {},
          onDeleteSession: () => {},
          bulk: bulk as unknown as BulkActions,
        }),
      ),
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const tick = (id: string) => act(() => container.querySelector<HTMLInputElement>(`input[aria-label="Select api feat/${id}"]`)!.click());
  const button = (label: string | RegExp) => [...container.querySelectorAll('button')].find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')))!;
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });

  it('tick rows → archive them; a refused one stays ticked with the reason', async () => {
    tick('a');
    tick('b');
    expect(container.querySelector('.wd-bulk-count')!.textContent).toBe('2 selected');
    await act(async () => button('Archive 2').click());
    await settle();
    expect(bulk.archive.mock.calls.map((c) => (c[0] as SessionSummary).id).sort()).toEqual(['a', 'b']);
    expect(container.querySelector('.wd-bulk-outcome')!.textContent).toContain('Archived 1; 1 refused: feat/b — its Claude is working');
    expect(container.querySelector('.wd-bulk-count')!.textContent).toBe('1 selected');
  });

  it('a mix: archive what is live, restore what is archived; select all shown', async () => {
    const all = container.querySelector<HTMLInputElement>('input[aria-label="Select all shown"]')!;
    act(() => all.click());
    expect(button(/^Archive \d/).textContent).toBe('Archive 3');
    expect(button(/^Restore \d/).textContent).toBe('Restore 1');
  });

  it('a ticked row the search hides is left out, and the bar says so', async () => {
    tick('a');
    tick('b');
    const box = container.querySelector<HTMLInputElement>('.wd-tab-search')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'feat/a');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelector('.wd-bulk-count')!.textContent).toBe('1 selected');
    expect(container.querySelector('.wd-bulk-hidden')!.textContent).toContain('+1 hidden');
    await act(async () => button('Archive 1').click());
    await settle();
    expect(bulk.archive.mock.calls.map((c) => (c[0] as SessionSummary).id)).toEqual(['a']);
  });

  it('send one prompt to them all; delete asks first and never forces', async () => {
    tick('a');
    tick('c');
    await act(async () => button('Send a prompt…').click());
    const box = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Prompt to send"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Rebase on main');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Send to 2').click());
    await settle();
    expect(bulk.send.mock.calls.map((c) => [(c[0] as SessionSummary).id, c[1]]).sort()).toEqual([['a', 'Rebase on main'], ['c', 'Rebase on main']]);
    tick('a');
    await act(async () => button('Delete…').click());
    expect(container.textContent).toContain('A worktree goes only where nothing would be lost');
    expect(bulk.remove).not.toHaveBeenCalled();
    await act(async () => button('Delete').click());
    await settle();
    expect(bulk.remove).toHaveBeenCalledTimes(1);
  });
});

describe('the bulk bar’s real calls (defaultBulk)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('archive never forces: a session with work waiting is refused with why; delete sends no force', async () => {
    const { defaultBulk } = await import('../../src/web/src/components/Dashboard/tabs/SessionsTab.js');
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (url.endsWith('/archive')) return new Response(JSON.stringify({ blocked: ['its Claude is working'] }), { status: 409 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    await expect(defaultBulk.archive(session('a'))).rejects.toThrow('Not archived: its Claude is working');
    expect(calls.filter((c) => c.url.endsWith('/archive'))).toHaveLength(1); // asked once, not again with force
    await defaultBulk.remove(session('b'));
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.url).toContain('/api/sessions/b/worktree');
    expect(JSON.parse(del.body ?? '{}')).toEqual({});
  });
});
