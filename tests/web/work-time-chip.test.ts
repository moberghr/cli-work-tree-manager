// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { dayKey } from '../../src/core/work-time-view.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchWorkTime: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchWorkTime: (id: string) => api.fetchWorkTime(id),
}));
const { WorkTimeChip, worklogLine } = await import('../../src/web/src/components/Dashboard/WorkTimeChip.js');

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: 's1', target: 'api', branch: 'feat/x', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', activityState: 'stale', lastActivity: 1, ...over }) as SessionSummary;
const today = dayKey(Date.now());
const time = { workedMs: 95 * 60_000, prompts: 7, byDay: [{ day: today, ms: 50 * 60_000 }], firstAt: null, lastAt: null };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.fetchWorkTime.mockReset().mockResolvedValue(time);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('worklogLine', () => {
  it("the latest day's work with the Jira key, rounded up to a quarter hour — never a lifetime total", () => {
    expect(worklogLine({ jiraKey: 'PAY-12', title: 'Retry payments', branch: 'feat/x' }, time)).toEqual({ text: 'PAY-12 1h — Retry payments', day: today });
    const earlier = { ...time, byDay: [{ day: '2026-09-28', ms: 20 * 60_000 }, { day: '2026-09-27', ms: 3 * 3600_000 }] };
    expect(worklogLine({ branch: 'feat/x', title: null } as never, earlier)).toEqual({ text: '30m — feat/x', day: '2026-09-28' });
    expect(worklogLine({ branch: 'feat/x', title: null } as never, { ...time, byDay: [] })).toBeNull();
  });
});

describe('WorkTimeChip', () => {
  it('shows the total, explains it, and copies the worklog line on click', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await act(async () => root.render(createElement(WorkTimeChip, { session: session({ jiraKey: 'PAY-12' }) })));
    const chip = container.querySelector<HTMLButtonElement>('.wd-work-time')!;
    expect(chip.textContent).toBe('⏱ 1h 35m');
    expect(chip.title).toContain('over 7 prompts');
    expect(chip.title).toContain('Today 50m');
    await act(async () => chip.click());
    expect(writeText).toHaveBeenCalledWith('PAY-12 1h — feat/x');
    expect(chip.textContent).toBe('⏱ Copied');
  });

  it('asks again for another session at once, but the same one at most once a minute', async () => {
    await act(async () => root.render(createElement(WorkTimeChip, { session: session() })));
    await act(async () => root.render(createElement(WorkTimeChip, { session: session({ lastActivity: 2 }) })));
    expect(api.fetchWorkTime).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(WorkTimeChip, { session: session({ id: 's2' }) })));
    expect(api.fetchWorkTime).toHaveBeenLastCalledWith('s2');
  });

  it("a copy that fails says so (no dead button); nothing to log in two weeks: it can't be clicked", async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    await act(async () => root.render(createElement(WorkTimeChip, { session: session() })));
    const chip = container.querySelector<HTMLButtonElement>('.wd-work-time')!;
    await act(async () => chip.click());
    expect(chip.textContent).toBe("⏱ Couldn't copy");
    api.fetchWorkTime.mockResolvedValue({ ...time, byDay: [] });
    await act(async () => root.render(createElement(WorkTimeChip, { session: session({ id: 's9' }) })));
    expect(container.querySelector<HTMLButtonElement>('.wd-work-time')!.disabled).toBe(true);
  });

  it('a change inside the minute is caught up when the minute is over', async () => {
    vi.useFakeTimers();
    try {
      await act(async () => root.render(createElement(WorkTimeChip, { session: session() })));
      await act(async () => root.render(createElement(WorkTimeChip, { session: session({ lastActivity: 2 }) })));
      expect(api.fetchWorkTime).toHaveBeenCalledTimes(1);
      await act(async () => { vi.advanceTimersByTime(61_000); });
      expect(api.fetchWorkTime).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('under a minute: nothing shown', async () => {
    api.fetchWorkTime.mockResolvedValue({ ...time, workedMs: 20_000 });
    await act(async () => root.render(createElement(WorkTimeChip, { session: session() })));
    expect(container.textContent).toBe('');
  });
});
