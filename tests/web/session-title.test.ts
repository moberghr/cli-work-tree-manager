// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({ renameSession: vi.fn(async () => {}) }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  renameSession: h.renameSession,
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
vi.mock('../../src/web/src/components/Diff/DiffView.js', () => ({ DiffView: () => null }));
vi.mock('../../src/web/src/components/Terminal/PtyView.js', () => ({ PtyView: () => null }));

import { SessionTitle } from '../../src/web/src/components/Dashboard/SessionDetail.js';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.renameSession.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const session = (over: Partial<SessionSummary> = {}) => ({ id: 's1', target: 'api', branch: 'fix/keys', title: 'Rotate the terminal keys', ...over }) as SessionSummary;

describe('SessionTitle', () => {
  it('shows the automatic name, and renames on Enter', async () => {
    act(() => root.render(createElement(SessionTitle, { session: session() })));
    const btn = container.querySelector<HTMLButtonElement>('.wd-session-title')!;
    expect(btn.textContent).toBe('Rotate the terminal keys');
    expect(btn.title).toContain('first prompt');
    act(() => btn.click());
    const input = container.querySelector<HTMLInputElement>('.wd-session-title-input')!;
    expect(input.value).toBe(''); // an automatic name isn't pre-filled: you type yours
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(input, 'Key rotation');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(h.renameSession).toHaveBeenCalledWith('s1', 'Key rotation');
  });

  it('Esc leaves it as it was', () => {
    act(() => root.render(createElement(SessionTitle, { session: session({ title: 'Mine', titleIsYours: true }) })));
    act(() => container.querySelector<HTMLButtonElement>('.wd-session-title')!.click());
    const input = container.querySelector<HTMLInputElement>('.wd-session-title-input')!;
    expect(input.value).toBe('Mine');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(h.renameSession).not.toHaveBeenCalled();
    expect(container.querySelector('.wd-session-title')?.textContent).toBe('Mine');
  });
});
