// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchTimeline: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchTimeline: (id: string) => api.fetchTimeline(id),
}));
const { TimelineView, byDay } = await import('../../src/web/src/components/Dashboard/TimelineView.js');

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

const EVENTS = [
  { at: '2026-10-02T11:00:00Z', kind: 'pr-merged', text: 'Merged PR #7', ref: 'https://github.com/x/api/pull/7' },
  { at: '2026-10-01T10:05:00Z', kind: 'commit', text: 'Add CSV export', ref: 'abc1234def' },
  { at: '2026-10-01T09:05:00Z', kind: 'prompt', text: 'Add a CSV export' },
] as const;

describe('TimelineView', () => {
  it('by day, newest first: a PR links to its page, a commit shows its short sha', async () => {
    api.fetchTimeline.mockResolvedValue(EVENTS);
    await act(async () => root.render(createElement(TimelineView, { session: { id: 's1', isGroup: false, lastActivity: 1 } as SessionSummary })));
    expect(container.querySelectorAll('.wd-timeline-day')).toHaveLength(2);
    expect(container.querySelector<HTMLAnchorElement>('.wd-timeline-pr-merged a')!.href).toBe('https://github.com/x/api/pull/7');
    expect(container.querySelector('.wd-timeline-sha')!.textContent).toBe('abc1234');
    expect(byDay([...EVENTS]).map((g) => g.events.length)).toEqual([1, 2]);
  });

  it('says so while it reads, and when it fails', async () => {
    api.fetchTimeline.mockReturnValue(new Promise(() => {}));
    act(() => root.render(createElement(TimelineView, { session: { id: 's1', isGroup: false } as SessionSummary })));
    expect(container.textContent).toContain('Reading its history');
    api.fetchTimeline.mockRejectedValue(new Error('git is gone'));
    await act(async () => root.render(createElement(TimelineView, { session: { id: 's2', isGroup: false } as SessionSummary })));
    expect(container.textContent).toContain('git is gone');
  });
});
