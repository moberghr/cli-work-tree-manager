// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionAttention, SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ snoozeSession: vi.fn(), unsnoozeSession: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  snoozeSession: (s: unknown, c: unknown) => api.snoozeSession(s, c),
  unsnoozeSession: (id: string) => api.unsnoozeSession(id),
}));
const { InboxTab } = await import('../../src/web/src/components/Dashboard/tabs/InboxTab.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.snoozeSession.mockReset().mockResolvedValue({ ok: true });
  api.unsnoozeSession.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const att = (state: SessionAttention['state'], seen: boolean, summary: string): SessionAttention => ({
  state,
  seen,
  since: minsAgo(5),
  updatedAt: minsAgo(5),
  summary,
  stale: false,
});
const session = (id: string, attention: SessionAttention, extra: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id,
    target: 'repo',
    branch: id,
    isGroup: false,
    paths: [`/wt/${id}`],
    createdAt: minsAgo(100),
    lastAccessedAt: minsAgo(100),
    attention,
    activityState: 'stale',
    ...extra,
  }) as SessionSummary;

const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('snooze in the inbox', () => {
  it('a snoozed session leaves the Inbox: counted in the closing line, not listed', () => {
    const sessions = [
      session('done-one', att('idle', false, 'Added the endpoint')),
      session('later', att('idle', false, 'Fixed the flake'), { snoozed: { until: null } }),
    ];
    act(() => root.render(createElement(InboxTab, { sessions, onOpenSession: () => {} })));
    const sections = [...container.querySelectorAll('.wd-inbox-section-title')].map((h) => h.textContent);
    expect(sections).toEqual(['Done · 1Review all'.replace('Review all', '')]);
    expect(container.textContent).not.toContain('later');
    expect(container.querySelector('.wd-inbox-rest')!.textContent).toContain('1 snoozed');
    expect(container.querySelector('.wd-tab-header h1')!.textContent).toContain('1 needs you');
  });

  it('Snooze on a row that wants you: pick how long', async () => {
    const s = session('done-one', att('idle', false, 'Added the endpoint'));
    act(() => root.render(createElement(InboxTab, { sessions: [s], onOpenSession: () => {} })));
    await act(async () => button('Snooze').click());
    const items = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(items.map((i) => i.firstElementChild!.textContent)).toEqual(['2 hours', 'Until tomorrow 9:00', 'Until it changes', 'Until…']);
    await act(async () => items[1].click());
    expect(api.snoozeSession).toHaveBeenCalledWith(s, 'tomorrow');
  });
});
