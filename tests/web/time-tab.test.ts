// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TimeDaysWire, TimeDayWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const settings = {
  dayHours: 7.5,
  multiplier: 5,
  capHours: 7,
  stepHours: 0.25,
  minHours: 0.5,
  gapTicket: 'APP-434',
  timeOffTicket: 'HR-1',
  effort: false,
};
const dayWire = (over: Partial<TimeDayWire> = {}): TimeDayWire => ({
  day: '2026-10-08',
  status: 'draft',
  workday: true,
  dayOff: false,
  suggested: [
    { key: 'APP-1', hours: 2.5 },
    { key: 'APP-434', hours: 5 },
  ],
  entries: [
    { key: 'APP-1', hours: 2.5 },
    { key: 'APP-434', hours: 5 },
  ],
  edited: false,
  unallocated: 0,
  total: 7.5,
  evidence: {
    sessions: [{ sessionId: 'sess-1', label: 'api · feat/APP-1-x', key: 'APP-1', minutes: 30 }],
    commits: [{ repo: 'api', sha: 'a1', subject: 'APP-1: the thing', keys: ['APP-1'] }],
    jira: [],
  },
  titles: { 'APP-1': 'The thing', 'APP-434': 'Meetings' },
  builtAt: '2026-10-08T15:00:00Z',
  settings,
  posted: null,
  posting: { ready: true, why: null },
  vacation: false,
  resolved: [],
  placeholders: [],
  ...over,
});

const api = vi.hoisted(() => ({
  days: null as unknown as TimeDaysWire,
  day: null as unknown as TimeDayWire,
  /** When set, a day's fetch answers when the test says (out of order). */
  fetchDay: null as null | ((day: string) => Promise<TimeDayWire>),
  save: vi.fn(),
  rebuild: vi.fn(),
  post: vi.fn(),
  graph: {
    ready: true,
    why: null,
    account: null,
    problem: null,
    login: null,
    error: null,
  } as import('../../src/core/api-types.js').TimeGraphWire,
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('../../src/web/src/api/panes.js', () => ({
  fetchTimeDays: async () => api.days,
  fetchTimeDay: (d: string) => (api.fetchDay ? api.fetchDay(d) : Promise.resolve(api.day)),
  saveTimeDay: (day: string, change: unknown) => api.save(day, change),
  rebuildTimeDay: (day: string) => api.rebuild(day),
  postTimeDay: (day: string) => api.post(day),
  fetchTimeGraph: async () => api.graph,
  connectTimeGraph: () => api.connect(),
  disconnectTimeGraph: () => api.disconnect(),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { TimeTab, dayLabel, hoursText, postOutcome } = await import('../../src/web/src/components/Dashboard/tabs/TimeTab.js');

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
  api.fetchDay = null;
  api.save.mockReset().mockImplementation(async (_d: string, change: { entries?: unknown; dayOff?: boolean }) =>
    change.dayOff
      ? dayWire({ status: 'off', dayOff: true, entries: [{ key: 'HR-1', hours: 7.5 }] })
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
    act(() => button('api · feat/APP-1-x').click());
    expect(onOpenSession).toHaveBeenCalledWith('sess-1');
  });

  it('change hours, add a ticket: Save sends your rows; Undo puts them back', async () => {
    await render();
    expect(button('Save').disabled).toBe(true);
    const hours = container.querySelectorAll<HTMLInputElement>('.wd-time-hours');
    act(() => setValue(hours[0], '3'));
    act(() => button('+ Add a ticket').click());
    const keys = container.querySelectorAll<HTMLInputElement>('.wd-time-key');
    act(() => setValue(keys[2], 'app-9'));
    expect(container.querySelector('.wd-time-rows tfoot')!.textContent).toContain('8.5 h / 7.5 h');
    expect(button('Undo changes')).toBeTruthy();
    await act(async () => button('Save').click());
    expect(api.save).toHaveBeenCalledWith('2026-10-08', {
      entries: [
        { key: 'APP-1', hours: 3 },
        { key: 'APP-434', hours: 5 },
        { key: 'APP-9', hours: 0.5 },
      ],
    });
    expect(container.querySelector('.wd-time-detail-head .wd-time-day-status')!.textContent).toBe('edited');
  });

  it('a day off; back to the suggestion when edited; Gather again', async () => {
    api.day = dayWire({ status: 'edited', edited: true, entries: [{ key: 'APP-1', hours: 7.5 }] });
    await render();
    expect(container.textContent).toContain('Suggested: APP-1 2.5 h, APP-434 5 h');
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

  it('Post to Tempo: only once saved; says what it did; then the day reads "in Tempo"', async () => {
    api.post.mockResolvedValue({
      posted: 2,
      removed: 0,
      kept: 0,
      coveredByHand: 0,
      otherByHand: 1,
      failed: [],
      day: dayWire({ status: 'posted', posted: { at: '2026-10-08T16:00:00Z', entries: dayWire().entries } }),
    });
    await render();
    act(() => setValue(container.querySelectorAll<HTMLInputElement>('.wd-time-hours')[0], '3'));
    expect(button('Post to Tempo').disabled).toBe(true); // save first
    act(() => button('Undo changes').click());
    await act(async () => button('Post to Tempo').click());
    expect(api.post).toHaveBeenCalledWith('2026-10-08');
    expect(container.querySelector('.wd-time-outcome')!.textContent).toBe('Tempo: 2 posted. 1 other worklog of yours that day left alone.');
    expect(container.querySelector('.wd-time-detail-head .wd-time-day-status')!.textContent).toBe('in Tempo');
    expect(button('Post again').disabled).toBe(true); // nothing changed since
  });

  it('a posted day emptied since (all rows out): it can be taken out of Tempo; an empty day never posted: nothing to post', async () => {
    api.day = dayWire({
      status: 'changed',
      entries: [],
      total: 0,
      posted: { at: '2026-10-08T16:00:00Z', entries: dayWire().entries },
    });
    await render();
    expect(button('Take out of Tempo').disabled).toBe(false);
    await act(async () => button('Take out of Tempo').click());
    expect(api.post).toHaveBeenCalledWith('2026-10-08');
    act(() => root.unmount());
    root = createRoot(container);
    api.day = dayWire({ entries: [], total: 0 });
    await render();
    expect(button('Post to Tempo').disabled).toBe(true);
  });

  it('posting not set up: the button says why', async () => {
    api.day = dayWire({ posting: { ready: false, why: 'No Tempo token: set TEMPO_API_TOKEN' } });
    await render();
    expect(button('Post to Tempo').disabled).toBe(true);
    expect(container.textContent).toContain('No Tempo token: set TEMPO_API_TOKEN');
  });

  it('what a post did, in a line', () => {
    expect(postOutcome({ posted: 0, removed: 0, kept: 2, coveredByHand: 0, otherByHand: 0, failed: [] })).toBe('Tempo: 2 already there.');
    expect(postOutcome({ posted: 0, removed: 0, kept: 0, coveredByHand: 0, otherByHand: 0, failed: [] })).toBe(
      'Tempo already had the day as it is.',
    );
    expect(
      postOutcome({ posted: 1, removed: 1, kept: 0, coveredByHand: 1, otherByHand: 0, failed: [{ key: 'SD-X', error: 'no such issue' }] }),
    ).toBe('Tempo: 1 posted, 1 removed, 1 you had logged by hand. Not posted: SD-X (no such issue).');
  });

  it('Outlook & Teams: Connect shows the code to enter; signed in: from whom, Disconnect', async () => {
    api.connect.mockResolvedValue({
      ...api.graph,
      login: { userCode: 'ABCD-1234', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: 'x' },
    });
    await render();
    expect(container.querySelector('.wd-time-graph')!.textContent).toContain('not connected');
    await act(async () => button('Connect').click());
    expect(container.querySelector('.wd-time-graph')!.textContent).toContain('enter ABCD-1234 at microsoft.com/devicelogin');
    act(() => root.unmount());
    root = createRoot(container);
    api.graph = { ...api.graph, account: 'you@example.com' };
    api.disconnect.mockResolvedValue({ ...api.graph, account: null });
    await render();
    expect(container.querySelector('.wd-time-graph')!.textContent).toContain('meetings and chats from you@example.com');
    await act(async () => button('Disconnect').click());
    expect(api.disconnect).toHaveBeenCalled();
    api.graph = { ...api.graph, account: null };
  });

  it('signed in but it stopped working: says why, with Connect again (which shows the code)', async () => {
    api.graph = {
      ...api.graph,
      account: 'you@example.com',
      problem: 'The Microsoft sign-in stopped working (expired or revoked): connect again.',
    };
    api.connect.mockResolvedValue({
      ...api.graph,
      login: { userCode: 'WXYZ-9876', verificationUri: 'https://microsoft.com/devicelogin', expiresAt: 'x' },
    });
    try {
      await render();
      expect(container.querySelector('.wd-time-graph')!.textContent).toContain('stopped working');
      expect(container.querySelector('.wd-time-graph')!.textContent).not.toContain('meetings and chats from');
      await act(async () => button('Connect again').click());
      expect(container.querySelector('.wd-time-graph')!.textContent).toContain('enter WXYZ-9876');
    } finally {
      api.graph = { ...api.graph, account: null, problem: null };
    }
  });

  it('meetings and chats in the evidence; what the AI step placed is marked', async () => {
    api.day = dayWire({
      evidence: {
        sessions: [{ sessionId: 's', label: 'api · chore/pdf', key: 'APP-2', minutes: 12, guessed: true }],
        commits: [],
        jira: [],
        meetings: [
          { subject: 'Daily standup', start: '09:30', end: '09:45', minutes: 15, key: null },
          { subject: 'PDF refinement', start: '14:00', end: '15:00', minutes: 60, key: 'APP-2', guessed: true },
        ],
        chats: [{ chat: 'Payments', messages: 3, sample: ['x'], key: 'APP-2', guessed: true }],
      },
    });
    await render();
    const ev = container.querySelector('.wd-time-evidence')!;
    expect(ev.querySelector('[aria-label="Meetings"]')!.textContent).toContain('APP-434 09:30–09:45 Daily standup · 15 min'); // unplaced: the gap ticket
    expect(ev.querySelectorAll('.wd-time-ai')).toHaveLength(3);
    expect(ev.querySelector('[aria-label="Chats"]')!.textContent).toContain('Teams: Payments · 3 messages of yours');
  });

  it('tells the dashboard which day is on screen; Ask about this day opens the assistant', async () => {
    const onDayChange = vi.fn();
    const onAsk = vi.fn();
    act(() => root.render(createElement(TimeTab, { onOpenSession, onDayChange, onAsk })));
    await flush();
    await flush();
    expect(onDayChange).toHaveBeenLastCalledWith('2026-10-08');
    act(() => button('Ask about this day').click());
    expect(onAsk).toHaveBeenCalled();
  });

  it("a slow answer for the day you left doesn't land on the day you're on", async () => {
    const waiting = new Map<string, (w: TimeDayWire) => void>();
    api.fetchDay = (d) => new Promise((res) => waiting.set(d, res));
    act(() => root.render(createElement(TimeTab, { onOpenSession })));
    await flush();
    await flush();
    act(() => button(new RegExp(`^${dayLabel('2026-10-07')}`)).click());
    await flush();
    // Tuesday answers first, then Monday's old request.
    await act(async () => waiting.get('2026-10-07')!(dayWire({ day: '2026-10-07', entries: [{ key: 'APP-7', hours: 7.5 }] })));
    await act(async () => waiting.get('2026-10-08')!(dayWire({ day: '2026-10-08', entries: [{ key: 'APP-8', hours: 7.5 }] })));
    const keys = [...container.querySelectorAll<HTMLInputElement>('.wd-time-key')].map((i) => i.value);
    expect(keys).toEqual(['APP-7']);
  });

  it('a resolved ticket and a placeholder are said on their rows; a vacation day is fixed as one', async () => {
    api.day = dayWire({ resolved: ['APP-1'], placeholders: ['APP-434'] });
    await render();
    const titles = [...container.querySelectorAll('.wd-time-rows tbody .wd-time-title')].map((t) => t.textContent);
    expect(titles).toEqual(['The thingresolved', 'Meetingscreate in Jira first']);
    act(() => root.unmount());
    root = createRoot(container);
    api.day = dayWire({ dayOff: true, vacation: true, status: 'off', entries: [{ key: 'HR-1', hours: 7.5 }] });
    await render();
    const box = container.querySelector<HTMLInputElement>('.wd-time-off input')!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(container.querySelector('.wd-time-off')!.textContent).toBe('Vacation');
  });

  it("unsaved rows aren't thrown away: Day off and Gather again wait for Save or Undo; leaving the day asks", async () => {
    await render();
    act(() => setValue(container.querySelectorAll<HTMLInputElement>('.wd-time-hours')[0], '3'));
    expect(button('Gather again').disabled).toBe(true);
    expect(container.querySelector<HTMLInputElement>('.wd-time-off input')!.disabled).toBe(true);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    act(() => button(new RegExp(`^${dayLabel('2026-10-07')}`)).click());
    expect(confirm).toHaveBeenCalled();
    expect(container.querySelector('.wd-time-detail-head h2')!.textContent).toBe(dayLabel('2026-10-08')); // stayed
    expect(container.querySelectorAll<HTMLInputElement>('.wd-time-hours')[0].value).toBe('3');
    confirm.mockRestore();
  });

  it('hours read as hours', () => {
    expect(hoursText(2.5)).toBe('2.5 h');
    expect(hoursText(0.25)).toBe('0.25 h');
    expect(hoursText(7)).toBe('7 h');
  });
});
