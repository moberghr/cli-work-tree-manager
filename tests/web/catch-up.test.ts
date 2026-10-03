// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ catchUpSession: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  catchUpSession: (id: string) => api.catchUpSession(id),
}));
const { AwayLink, CatchUpPanel, useCatchUp } = await import('../../src/web/src/components/Dashboard/CatchUp.js');
let runCatchUp: () => void;
/** What the session header does: the status line's Away link, the ⋯ menu's run, the panel under it. */
function Header({ s, now }: { s: SessionSummary; now: number }) {
  const c = useCatchUp(s.id);
  runCatchUp = c.run;
  return createElement(
    'div',
    null,
    createElement(AwayLink, { session: s, catchUp: c, now }),
    createElement(CatchUpPanel, { catchUp: c, now }),
  );
}

const NOW = Date.parse('2026-10-01T12:00:00Z');
const session = (lastMs: number): SessionSummary =>
  ({
    id: 's1',
    target: 'api',
    branch: 'fix/pdf',
    isGroup: false,
    paths: [],
    createdAt: new Date(lastMs).toISOString(),
    lastAccessedAt: new Date(lastMs).toISOString(),
    activityState: 'stale',
  }) as SessionSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.catchUpSession.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Catch me up', () => {
  it('after two quiet days the status line says how long you were away; click shows the summary', async () => {
    api.catchUpSession.mockResolvedValue({ text: 'The PDF job is faster; a PR is waiting for you.', at: new Date(NOW).toISOString() });
    act(() => root.render(createElement(Header, { s: session(NOW - 3 * 24 * 3600_000), now: NOW })));
    const btn = container.querySelector('button')!;
    expect(btn.textContent).toBe('Away 3d · Catch me up');
    await act(async () => btn.click());
    expect(api.catchUpSession).toHaveBeenCalledWith('s1');
    expect(container.querySelector('.wd-catch-up-text')!.textContent).toBe('The PDF job is faster; a PR is waiting for you.');
    // The link goes while the summary shows.
    expect(container.textContent).not.toContain('Away 3d');
  });

  it('recently used: no link (the ⋯ menu runs it); a failure says why, and Close hides it', async () => {
    api.catchUpSession.mockRejectedValue(new Error('Nothing to go on: no conversation in the last week, or no answer from Claude.'));
    act(() => root.render(createElement(Header, { s: session(NOW - 3600_000), now: NOW })));
    expect(container.querySelector('button')).toBeNull();
    await act(async () => runCatchUp());
    expect(container.textContent).toContain('Nothing to go on');
    const close = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Close')!;
    act(() => close.click());
    expect(container.querySelector('.wd-catch-up')).toBeNull();
  });
});
