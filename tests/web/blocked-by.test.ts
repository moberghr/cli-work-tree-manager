// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ addBlocker: vi.fn(), removeBlocker: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  addBlocker: (id: string, ref: unknown) => api.addBlocker(id, ref),
  removeBlocker: (id: string, key?: string) => api.removeBlocker(id, key),
}));
const { BlockedByChip, BlockedByDialog } = await import('../../src/web/src/components/Dashboard/BlockedBy.js');

const s = (id: string, over: Partial<SessionSummary> = {}) => ({ id, target: 'api', branch: `feat/${id}`, ...over }) as SessionSummary;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  api.addBlocker.mockReset().mockResolvedValue(undefined);
  api.removeBlocker.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('BlockedByChip', () => {
  it('names what it waits on (a session opens on click), each with × to stop waiting', async () => {
    const onOpen = vi.fn();
    const session = s('a', {
      blockedBy: [
        { key: 'session:b', kind: 'session', label: 'feat/b', sessionId: 'b' },
        { key: 'pr:u', kind: 'pr', label: 'api#12', url: 'https://github.com/x/api/pull/12' },
      ],
    });
    act(() => root.render(createElement(BlockedByChip, { session, onOpen })));
    expect(container.textContent).toContain('Waiting on feat/b×, api#12×');
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'feat/b')!.click());
    expect(onOpen).toHaveBeenCalledWith('b');
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Stop waiting on api#12"]')!.click());
    expect(api.removeBlocker).toHaveBeenCalledWith('a', 'pr:u');
  });
});

describe('BlockedByDialog', () => {
  it('another live session (not itself, not archived), or a PR URL; a bad URL says so', async () => {
    const onDone = vi.fn();
    act(() =>
      root.render(
        createElement(BlockedByDialog, {
          session: s('a'),
          sessions: [s('a'), s('b'), s('c', { archivedAt: 'x' })],
          onDone,
          onClose: () => {},
        }),
      ),
    );
    const options = [...container.querySelectorAll('option')].map((o) => o.textContent);
    expect(options).toEqual(['—', 'api · feat/b']);
    act(() => {
      const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://example.com/x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Not a GitHub pull request URL');
    act(() => {
      const sel = container.querySelector('select')!;
      sel.value = 'b';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const input = container.querySelector<HTMLInputElement>('input[type="url"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/acme/api/pull/7');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(api.addBlocker).toHaveBeenCalledWith('a', { kind: 'session', id: 'b' });
    expect(api.addBlocker).toHaveBeenCalledWith('a', { kind: 'pr', url: 'https://github.com/acme/api/pull/7' });
    expect(onDone).toHaveBeenCalledWith('feat/b and api#7');
  });
});
