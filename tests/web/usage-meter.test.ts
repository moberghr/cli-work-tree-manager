// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UsageWire } from '../../src/core/api-types.js';

// What the meter asked the event stream for: the test fires its handlers.
const sse = vi.hoisted(() => ({
  url: null as string | null,
  handlers: null as null | { events?: Record<string, (d: unknown) => void>; onOpen?: () => void },
}));
vi.mock('../../src/web/src/api/events.js', () => ({
  useSse: (url: string | null, handlers: NonNullable<typeof sse.handlers>) => {
    sse.url = url;
    sse.handlers = handlers;
  },
}));
import { UsageMeter } from '../../src/web/src/components/Dashboard/UsageMeter.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const zero = { input: 0, cached: 0, output: 0 };

const WIRE: UsageWire = {
  agents: [
    {
      agent: 'claude',
      name: 'Claude Code',
      accounts: [
        {
          account: 'a1',
          at: ago(3 * 60_000),
          windows: [
            { id: 'five_hour', label: '5-hour limit', usedPercent: 42, resetsAt: inMs(60 * 60_000) },
            { id: 'seven_day', label: 'Weekly limit', usedPercent: 18, resetsAt: inMs(3 * 24 * 3_600_000) },
          ],
        },
      ],
    },
  ],
  tokens: {
    today: { input: 1200, cached: 48_000, output: 300 },
    week: { input: 9000, cached: 1_600_000, output: 2000 },
    byModel: [{ model: 'opus', today: zero, week: { input: 9000, cached: 0, output: 2000 } }],
    topSessions: [{ id: 's1', label: 'api · feat/x', week: { input: 5000, cached: 0, output: 1000 } }],
  },
  at: ago(0),
};

async function mount(wire: UsageWire, onOpenSession = vi.fn()) {
  await act(async () => {
    root.render(createElement(UsageMeter, { onOpenSession, load: () => Promise.resolve(wire) }));
  });
  await flush();
  return onOpenSession;
}
const button = () => container.querySelector<HTMLButtonElement>('button.wd-usage-meter')!;
const click = (el: Element) => {
  void act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('UsageMeter', () => {
  it('shows the window nearest its limit on the button', async () => {
    await mount(WIRE);
    expect(button().textContent).toContain('Claude 5h 42%');
    expect(button().className).toContain('wd-usage-ok');
    expect(button().getAttribute('aria-expanded')).toBe('false');
  });

  it('says "Usage" when no agent has a reading', async () => {
    await mount({ ...WIRE, agents: [] });
    expect(button().textContent).toContain('Usage');
    expect(button().className).toContain('wd-usage-none');
  });

  it('opens a panel with the windows, reset phrases and tokens', async () => {
    await mount(WIRE);
    click(button());
    const panel = container.querySelector('.wd-usage-panel')!;
    expect(panel.hasAttribute('data-popover')).toBe(true);
    expect(panel.textContent).toContain('Claude Code');
    expect(panel.textContent).toContain('5-hour limit');
    expect(panel.textContent).toContain('42%');
    expect(panel.textContent).toContain('Weekly limit');
    expect(panel.textContent).toMatch(/resets \d\d:\d\d/);
    expect(panel.textContent).toMatch(/resets \w{3} \d\d:\d\d/);
    expect(panel.textContent).toContain('read 3 min ago');
    // Today's row: in, cached, out in their columns.
    const today = [...panel.querySelectorAll('.wd-usage-tokens tbody tr')].find((r) => r.querySelector('th')?.textContent === 'Today')!;
    expect([...today.querySelectorAll('td')].map((td) => td.textContent)).toEqual(['1.2k', '48k', '300']);
    expect(panel.textContent).toContain('opus');
  });

  it('a session under "Most this week" opens it and closes the panel', async () => {
    const open = await mount(WIRE);
    click(button());
    const link = [...container.querySelectorAll('.wd-usage-top button')].find((b) => b.textContent === 'api · feat/x')!;
    click(link);
    expect(open).toHaveBeenCalledWith('s1');
    expect(container.querySelector('.wd-usage-panel')).toBeNull();
  });

  it('Escape closes it', async () => {
    await mount(WIRE);
    click(button());
    expect(container.querySelector('.wd-usage-panel')).not.toBeNull();
    void act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.wd-usage-panel')).toBeNull();
  });

  it('a failed first fetch: "Usage", why in its title, and the panel says so', async () => {
    await act(async () => {
      root.render(createElement(UsageMeter, { onOpenSession: vi.fn(), load: () => Promise.reject(new Error('HTTP 500')) }));
    });
    await flush();
    expect(button().textContent).toContain('Usage');
    expect(button().title).toBe('Usage unavailable: HTTP 500');
    click(button());
    const panel = container.querySelector('.wd-usage-panel')!;
    expect(panel.textContent).toContain('Usage unavailable: HTTP 500');
    expect(panel.textContent).not.toContain('No agent reports');
  });

  it('a failed refresh keeps the numbers and says the last refresh failed', async () => {
    await mount(WIRE);
    // A new load: the effect fetches again, and this time it fails.
    await act(async () => {
      root.render(createElement(UsageMeter, { onOpenSession: vi.fn(), load: () => Promise.reject(new Error('HTTP 502')) }));
    });
    await flush();
    expect(button().textContent).toContain('Claude 5h 42%');
    click(button());
    const panel = container.querySelector('.wd-usage-panel')!;
    expect(panel.textContent).toContain('The last refresh failed (HTTP 502)');
    expect(panel.textContent).toContain('5-hour limit');
  });

  it('an old reading says so', async () => {
    const old: UsageWire = {
      ...WIRE,
      agents: [{ ...WIRE.agents[0]!, accounts: [{ ...WIRE.agents[0]!.accounts[0]!, at: ago(7 * 3_600_000) }] }],
    };
    await mount(old);
    click(button());
    expect(container.querySelector('.wd-usage-panel')!.textContent).toContain('last read 7 h ago — a running Claude refreshes it');
  });

  it('a mousedown outside closes it; one inside leaves it open', async () => {
    await mount(WIRE);
    click(button());
    const panel = container.querySelector('.wd-usage-panel')!;
    void act(() => {
      panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('.wd-usage-panel')).not.toBeNull();
    void act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('.wd-usage-panel')).toBeNull();
  });

  it('loads again on usage-changed and when the event stream (re)opens', async () => {
    let calls = 0;
    let pct = 42;
    const load = () => {
      calls++;
      const w = structuredClone(WIRE);
      w.agents[0]!.accounts[0]!.windows[0]!.usedPercent = pct;
      return Promise.resolve(w);
    };
    await act(async () => {
      root.render(createElement(UsageMeter, { onOpenSession: vi.fn(), load }));
    });
    await flush();
    expect(sse.url).toBe('/events');
    expect(calls).toBe(1);

    pct = 55;
    await act(async () => sse.handlers!.events!['usage-changed']!({}));
    await flush();
    expect(calls).toBe(2);
    expect(button().textContent).toContain('Claude 5h 55%');

    pct = 77;
    await act(async () => sse.handlers!.onOpen!());
    await flush();
    expect(calls).toBe(3);
    expect(button().textContent).toContain('Claude 5h 77%');
  });
});
