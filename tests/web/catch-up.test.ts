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
const { CatchUpButton } = await import('../../src/web/src/components/Dashboard/CatchUp.js');

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

describe('CatchUpButton', () => {
  it('after two quiet days it says how long you were away; click shows the summary', async () => {
    api.catchUpSession.mockResolvedValue({ text: 'The PDF job is faster; a PR is waiting for you.', at: new Date(NOW).toISOString() });
    act(() => root.render(createElement(CatchUpButton, { session: session(NOW - 3 * 24 * 3600_000), now: NOW })));
    const btn = container.querySelector('button')!;
    expect(btn.textContent).toMatch(/^Away 3d — catch me up$/);
    await act(async () => btn.click());
    expect(api.catchUpSession).toHaveBeenCalledWith('s1');
    expect(container.querySelector('.wd-catch-up-text')!.textContent).toBe('The PDF job is faster; a PR is waiting for you.');
  });

  it('recently used: a plain button; a failure says why', async () => {
    api.catchUpSession.mockRejectedValue(new Error('Nothing to go on: no conversation in the last week, or no answer from Claude.'));
    act(() => root.render(createElement(CatchUpButton, { session: session(NOW - 3600_000), now: NOW })));
    const btn = container.querySelector('button')!;
    expect(btn.textContent).toBe('Catch me up');
    await act(async () => btn.click());
    expect(container.textContent).toContain('Nothing to go on');
  });
});
