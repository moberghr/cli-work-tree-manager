// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DigestResponse } from '../../src/web/src/api/client.js';
import { TodayTab } from '../../src/web/src/components/Dashboard/tabs/TodayTab.js';
import { digestMarkdown, windowStart } from '../../src/web/src/state/digest.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
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

const SINCE = '2026-09-29T00:00:00.000Z';
const DIGEST: DigestResponse = {
  since: SINCE,
  generatedAt: '2026-09-29T17:00:00.000Z',
  sessions: [
    {
      sessionId: 's1',
      target: 'api',
      branch: 'feat/csv',
      isGroup: false,
      state: 'idle',
      summary: 'Export works',
      prompts: [{ ts: '2026-09-29T09:05:00.000Z', text: 'Add the CSV export' }],
      morePrompts: 2,
      turns: 3,
      turnLabels: ['Wrote the export', 'Added tests'],
      diffStat: { added: 40, deleted: 2, files: 3 },
      prs: [{ repo: 'api', number: 7, url: 'https://gh/7', state: 'MERGED', mergedAt: '2026-09-29T15:00:00.000Z' }],
      archivedAt: null,
      lastActivity: '2026-09-29T15:00:00.000Z',
    },
  ],
};
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('digest helpers', () => {
  it('windows start at local midnight', () => {
    const now = new Date(2026, 8, 29, 15, 30);
    expect(windowStart('today', now)).toEqual(new Date(2026, 8, 29));
    expect(windowStart('yesterday', now)).toEqual(new Date(2026, 8, 28));
    expect(windowStart('week', now)).toEqual(new Date(2026, 8, 23));
  });

  it('as Markdown, for a standup note', () => {
    expect(digestMarkdown(DIGEST, 'Today')).toBe(
      [
        '## Today',
        '',
        '1 session · 3 prompts · 3 turns · 1 merged',
        '',
        '### api · feat/csv',
        'idle · 3 turns · +40 −2 uncommitted · [#7](https://gh/7) merged',
        '',
        'Asked:',
        '- …2 earlier',
        '- Add the CSV export',
        '',
        'Done:',
        '- Wrote the export',
        '- Added tests',
        '',
      ].join('\n'),
    );
  });
});

describe('TodayTab', () => {
  it('shows each session: what you asked, what it did, its PRs; the window refetches', async () => {
    const load = vi.fn(async () => DIGEST);
    const onOpen = vi.fn();
    act(() => root.render(createElement(TodayTab, { onOpenSession: onOpen, load, copy: vi.fn(async () => {}) })));
    await flush();
    expect(load).toHaveBeenCalledWith(windowStart('today'));
    expect(text(container.querySelector('h1'))).toBe('Today (1 session · 3 prompts · 3 turns · 1 merged)');
    const card = container.querySelector('.wd-today-card')!;
    expect(text(card.querySelector('.wd-today-prompts'))).toContain('…2 earlier');
    expect(text(card.querySelector('.wd-today-prompts'))).toContain('Add the CSV export');
    expect([...card.querySelectorAll('.wd-today-done li')].map((li) => li.textContent)).toEqual(['Wrote the export', 'Added tests']);
    expect(text(card.querySelector('.wd-today-pr'))).toBe('#7 merged');
    act(() => card.querySelector<HTMLButtonElement>('.wd-today-title')!.click());
    expect(onOpen).toHaveBeenCalledWith('s1', 'diff');

    const select = container.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      select.value = 'week';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(load).toHaveBeenLastCalledWith(windowStart('week'));
    expect(text(container.querySelector('h1'))).toContain('Last 7 days');
  });

  it('copies the Markdown', async () => {
    const copy = vi.fn(async () => {});
    act(() => root.render(createElement(TodayTab, { onOpenSession: vi.fn(), load: async () => DIGEST, copy })));
    await flush();
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Copy as Markdown')!;
    await act(async () => btn.click());
    await flush();
    expect(copy).toHaveBeenCalledWith(digestMarkdown(DIGEST, 'Today'));
    expect(btn.textContent).toBe('Copied');
  });

  it("does not repeat the prompt as 'Last:' while the session is working on it", async () => {
    const working: DigestResponse = {
      ...DIGEST,
      sessions: [{ ...DIGEST.sessions[0], state: 'working', summary: 'Add the CSV export', turnLabels: [] }],
    };
    act(() => root.render(createElement(TodayTab, { onOpenSession: vi.fn(), load: async () => working })));
    await flush();
    expect(container.querySelector('.wd-today-last')).toBeNull();
    expect(digestMarkdown(working, 'Today')).not.toContain('Last:');
    const idle: DigestResponse = { ...working, sessions: [{ ...working.sessions[0], state: 'idle', summary: 'Export works' }] };
    expect(digestMarkdown(idle, 'Today')).toContain('Last: Export works');
  });

  it('marks a PR merged in the window, and says when earlier prompts are missing', async () => {
    const d: DigestResponse = {
      ...DIGEST,
      sessions: [
        {
          ...DIGEST.sessions[0],
          partial: true,
          prs: [
            { repo: 'api', number: 7, url: 'u7', state: 'MERGED', mergedAt: '2026-09-29T15:00:00.000Z' },
            { repo: 'api', number: 3, url: 'u3', state: 'MERGED', mergedAt: '2026-09-20T15:00:00.000Z' },
            { repo: 'web', number: 9, url: 'u9', state: 'OPEN' },
          ],
        },
      ],
    };
    act(() => root.render(createElement(TodayTab, { onOpenSession: vi.fn(), load: async () => d })));
    await flush();
    const prs = [...container.querySelectorAll('.wd-today-pr')].map((a) => [a.textContent, a.classList.contains('wd-today-pr-merged')]);
    expect(prs).toEqual([
      ['#7 merged', true],
      ['#3 merged', false],
      ['#9 open', false],
    ]);
    expect(text(container.querySelector('.wd-today-prompts'))).toContain('Earlier prompts not shown');
  });

  it("shows 'Copy failed' when the browser has no clipboard, instead of throwing", async () => {
    const saved = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    try {
      act(() => root.render(createElement(TodayTab, { onOpenSession: vi.fn(), load: async () => DIGEST })));
      await flush();
      const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Copy as Markdown')!;
      await act(async () => btn.click());
      await flush();
      expect(btn.textContent).toBe('Copy failed');
    } finally {
      Object.defineProperty(navigator, 'clipboard', { value: saved, configurable: true });
    }
  });

  it('says so when nothing happened', async () => {
    act(() => root.render(createElement(TodayTab, { onOpenSession: vi.fn(), load: async () => ({ ...DIGEST, sessions: [] }) })));
    await flush();
    expect(text(container)).toContain('No session did anything in this window.');
  });
});
