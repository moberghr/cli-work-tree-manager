// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TimeDaysWire, TimeDayWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = { dayHours: 7.5, multiplier: 5, capHours: 7, stepHours: 0.25, minHours: 0.5, gapTicket: 'SD-434', timeOffTicket: 'INT-1' };
const dayWire = (over: Partial<TimeDayWire> = {}): TimeDayWire => ({
  day: '2026-10-08',
  status: 'draft',
  workday: true,
  dayOff: false,
  suggested: [
    { key: 'SD-1', hours: 2.5 },
    { key: 'SD-434', hours: 5 },
  ],
  entries: [
    { key: 'SD-1', hours: 2.5 },
    { key: 'SD-434', hours: 5 },
  ],
  edited: false,
  unallocated: 0,
  total: 7.5,
  evidence: {
    sessions: [{ sessionId: 'sess-1', label: 'api · feat/SD-1-x', key: 'SD-1', minutes: 30 }],
    commits: [{ repo: 'api', sha: 'a1', subject: 'SD-1: the thing', keys: ['SD-1'] }],
    jira: [],
  },
  titles: { 'SD-1': 'The thing', 'SD-434': 'Meetings' },
  builtAt: '2026-10-08T15:00:00Z',
  settings,
  ...over,
});

const api = vi.hoisted(() => ({
  days: null as unknown as TimeDaysWire,
  day: null as unknown as TimeDayWire,
  save: vi.fn(),
  rebuild: vi.fn(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchTimeDays: async () => api.days,
  fetchTimeDay: async () => api.day,
  saveTimeDay: (day: string, change: unknown) => api.save(day, change),
  rebuildTimeDay: (day: string) => api.rebuild(day),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { TimeTab, dayLabel, hoursText } = await import('../../src/web/src/components/Dashboard/tabs/TimeTab.js');

let container: HTMLDivElement;
let root: Root;
const onOpenSession = vi.fn();
beforeEach(() => {
  api.days = {
    days: [
      { day: '2026-10-08', status: 'draft', workday: true, total: 7.5, tickets: 2 },
      { day: '2026-10-07', status: 'edited', workday: true, total: 7.5, tickets: 3 },
    ],
    settings,
  };
  api.day = dayWire();
  api.save.mockReset().mockImplementation(async (_d: string, change: { entries?: unknown; dayOff?: boolean }) =>
    change.dayOff
      ? dayWire({ status: 'off', dayOff: true, entries: [{ key: 'INT-1', hours: 7.5 }] })
      : change.entries === null
        ? dayWire() // back to the suggestion
        : dayWire({ status: 'edited', edited: true, entries: change.entries as TimeDayWire['entries'] }),
  );
  api.rebuild.mockReset().mockResolvedValue(dayWire());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function render() {
  act(() => root.render(createElement(TimeTab, { onOpenSession })));
  await flush();
  await flush();
}
const button = (label: string | RegExp) =>
  [...container.querySelectorAll('button')].find((b) =>
    typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''),
  )!;
const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('the Time tab', () => {
  it('lists the days and opens the newest: its rows with titles, the total against the day, and why', async () => {
    await render();
    expect([...container.querySelectorAll('.wd-time-day')].map((b) => b.textContent)).toEqual([
      `${dayLabel('2026-10-08')}suggested7.5 h`,
      `${dayLabel('2026-10-07')}edited7.5 h`,
    ]);
    const rows = [...container.querySelectorAll('.wd-time-rows tbody tr')];
    expect(rows.map((r) => r.querySelector('.wd-time-title')!.textContent)).toEqual(['The thing', 'Meetings']);
    expect(container.querySelector('.wd-time-rows tfoot')!.textContent).toContain('7.5 h / 7.5 h');
    expect(container.querySelector('.wd-time-evidence')!.textContent).toContain('30 min of Claude');
    act(() => button('api · feat/SD-1-x').click());
    expect(onOpenSession).toHaveBeenCalledWith('sess-1');
  });

  it('change hours, add a ticket: Save sends your rows; Undo puts them back', async () => {
    await render();
    expect(button('Save').disabled).toBe(true);
    const hours = container.querySelectorAll<HTMLInputElement>('.wd-time-hours');
    act(() => setValue(hours[0], '3'));
    act(() => button('+ Add a ticket').click());
    const keys = container.querySelectorAll<HTMLInputElement>('.wd-time-key');
    act(() => setValue(keys[2], 'sd-9'));
    expect(container.querySelector('.wd-time-rows tfoot')!.textContent).toContain('8.5 h / 7.5 h');
    expect(button('Undo changes')).toBeTruthy();
    await act(async () => button('Save').click());
    expect(api.save).toHaveBeenCalledWith('2026-10-08', {
      entries: [
        { key: 'SD-1', hours: 3 },
        { key: 'SD-434', hours: 5 },
        { key: 'SD-9', hours: 0.5 },
      ],
    });
    expect(container.querySelector('.wd-time-detail-head .wd-time-day-status')!.textContent).toBe('edited');
  });

  it('a day off; back to the suggestion when edited; Gather again', async () => {
    api.day = dayWire({ status: 'edited', edited: true, entries: [{ key: 'SD-1', hours: 7.5 }] });
    await render();
    expect(container.textContent).toContain('Suggested: SD-1 2.5 h, SD-434 5 h');
    await act(async () => button('Back to the suggestion').click());
    expect(api.save).toHaveBeenCalledWith('2026-10-08', { entries: null });
    await act(async () => container.querySelector<HTMLInputElement>('.wd-time-off input')!.click());
    expect(api.save).toHaveBeenLastCalledWith('2026-10-08', { dayOff: true });
    await act(async () => button('Gather again').click());
    expect(api.rebuild).toHaveBeenCalledWith('2026-10-08');
  });

  it('a refused save says why', async () => {
    api.save.mockRejectedValueOnce(new Error('entries: issue keys, hours in steps of 0.25, each key once'));
    await render();
    act(() => setValue(container.querySelectorAll<HTMLInputElement>('.wd-time-hours')[0], '3'));
    await act(async () => button('Save').click());
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('hours in steps of 0.25');
  });

  it('no gap ticket set: says so', async () => {
    api.days = { ...api.days, settings: { ...settings, gapTicket: null } };
    await render();
    expect(container.textContent).toContain('No ticket for the rest of the day is set');
  });

  it('hours read as hours', () => {
    expect(hoursText(2.5)).toBe('2.5 h');
    expect(hoursText(0.25)).toBe('0.25 h');
    expect(hoursText(7)).toBe('7 h');
  });
});
