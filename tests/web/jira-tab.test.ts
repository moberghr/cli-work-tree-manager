// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { JiraIssue, JiraWatchState } from '../../src/web/src/api/panes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  issues: [] as JiraIssue[],
  watch: null as unknown as JiraWatchState,
  setJiraWatch: vi.fn(),
  startJiraIssue: vi.fn(),
  dismissJiraIssue: vi.fn(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchJira: async () => ({ issues: api.issues, available: true }),
  fetchJiraWatch: async () => api.watch,
  setJiraWatch: (on: boolean) => api.setJiraWatch(on),
  startJiraIssue: (k: string, t: string) => api.startJiraIssue(k, t),
  dismissJiraIssue: (k: string) => api.dismissJiraIssue(k),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { JiraTab } = await import('../../src/web/src/components/Dashboard/tabs/JiraTab.js');

const issue = (key: string, status: string, statusCategory: JiraIssue['statusCategory']): JiraIssue => ({
  key,
  summary: `Do ${key}`,
  status,
  statusCategory,
  issuetype: 'Task',
  priority: 'Low',
  url: `u/${key}`,
});

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.issues = [issue('SD-3', 'Review', 'indeterminate'), issue('SD-1', 'New', 'new'), issue('SD-2', 'In Progress', 'indeterminate')];
  api.watch = {
    settings: { enabled: false, since: null },
    decisions: [
      {
        key: 'SD-1',
        summary: 'Do SD-1',
        url: 'u',
        at: '2026-10-01T10:00:00Z',
        action: 'suggested',
        target: 'straumur',
        reason: 'could be either',
      },
      {
        key: 'SD-2',
        summary: 'Do SD-2',
        url: 'u',
        at: '2026-10-01T10:00:00Z',
        action: 'started',
        target: 'jobly',
        sessionId: 'sid-2',
        reason: 'jobly work',
      },
    ],
    targets: ['straumur', 'jobly'],
    lastRunAt: null,
    nextRunAt: null,
  };
  for (const f of [api.setJiraWatch, api.startJiraIssue, api.dismissJiraIssue]) f.mockReset().mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('JiraTab', () => {
  it('columns in workflow order: to do, in progress, review', async () => {
    act(() => root.render(createElement(JiraTab, { onPick: () => {}, sessionJiraKeys: new Set<string>() })));
    await flush();
    expect([...container.querySelectorAll('.wd-jira-col-header span:first-child')].map((e) => e.textContent)).toEqual([
      'New',
      'In Progress',
      'Review',
    ]);
  });

  it('the switch turns the watch on', async () => {
    act(() => root.render(createElement(JiraTab, { onPick: () => {}, sessionJiraKeys: new Set<string>() })));
    await flush();
    const sw = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(sw.checked).toBe(false);
    await act(async () => sw.click());
    expect(api.setJiraWatch).toHaveBeenCalledWith(true);
  });

  it('a suggestion: pick a project and Start (without opening the New worktree dialog); a started one opens its session', async () => {
    const onPick = vi.fn();
    const onOpenSession = vi.fn();
    act(() => root.render(createElement(JiraTab, { onPick, sessionJiraKeys: new Set<string>(), onOpenSession })));
    await flush();
    expect(container.textContent).toContain('not sure where it belongs — maybe straumur');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Project for SD-1"]')!;
    expect(select.value).toBe('straumur');
    await act(async () => button('Start').click());
    expect(api.startJiraIssue).toHaveBeenCalledWith('SD-1', 'straumur');
    expect(onPick).not.toHaveBeenCalled();
    expect(container.textContent).toContain('started in jobly');
    await act(async () => button('open').click());
    expect(onOpenSession).toHaveBeenCalledWith('sid-2');
    expect(onPick).not.toHaveBeenCalled();
  });
});
