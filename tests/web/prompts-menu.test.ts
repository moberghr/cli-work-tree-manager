// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { PromptsMenu } from '../../src/web/src/components/Dashboard/PromptsMenu.js';

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

const session = (over: Partial<SessionSummary> = {}): SessionSummary => ({
  id: 's1',
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/wt/api'],
  createdAt: '',
  lastAccessedAt: '',
  ptyStatus: 'running',
  ...over,
});
const loadPrompts = async () => ({
  configured: true,
  prompts: [
    { label: 'Add tests', prompt: 'Write tests for it.' },
    { label: 'Web only', prompt: 'x', repos: ['web'] },
  ],
});
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
/** The session header's part: its ⋯ menu's "Send a prompt…" opens the list. */
function Header(props: { session: SessionSummary; loadPrompts: typeof loadPrompts; send: (id: string, p: string) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Send a prompt…'),
    createElement(PromptsMenu, { ...props, open, onOpenChange: setOpen }),
  );
}
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('PromptsMenu', () => {
  it("lists this session's prompts and sends the picked one to Claude", async () => {
    const send = vi.fn(async () => {});
    act(() => root.render(createElement(Header, { session: session(), loadPrompts, send })));
    await act(async () => button('Send a prompt…').click());
    await flush();
    const items = [...container.querySelectorAll('[role=menuitem]')].map((b) => b.textContent);
    expect(items).toEqual(['Add tests']); // "Web only" is for another repo
    await act(async () => button('Add tests').click());
    await flush();
    expect(send).toHaveBeenCalledWith('s1', 'Write tests for it.');
    expect(container.querySelector('[role=menu]')).toBeNull();
    expect(container.querySelector('[role=status]')?.textContent).toBe('"Add tests" sent to Claude');
  });

  it('opened from the menu, the keyboard is on the first prompt; Escape closes it', async () => {
    act(() => root.render(createElement(Header, { session: session(), loadPrompts, send: vi.fn(async () => {}) })));
    await act(async () => button('Send a prompt…').click());
    await flush();
    expect(document.activeElement?.textContent).toBe('Add tests');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('[role=menu]')).toBeNull();
  });

  it('says when it will arrive: after this turn, or on the next turn of a Claude outside the dashboard', async () => {
    const send = vi.fn(async () => {});
    const pickFor = async (s: SessionSummary) => {
      act(() => root.render(createElement(Header, { session: s, loadPrompts, send })));
      await act(async () => button('Send a prompt…').click());
      await flush();
      await act(async () => button('Add tests').click());
      await flush();
      return container.querySelector('[role=status]')?.textContent;
    };
    expect(await pickFor(session({ attention: { state: 'working', seen: true, since: '', updatedAt: '', stale: false } }))).toContain(
      'when this turn ends',
    );
    expect(await pickFor(session({ id: 's2', ptyStatus: 'idle' }))).toContain('next turn');
  });

  it('shows a failed send', async () => {
    const send = vi.fn(async () => {
      throw new Error('send failed (500)');
    });
    act(() => root.render(createElement(Header, { session: session(), loadPrompts, send })));
    await act(async () => button('Send a prompt…').click());
    await flush();
    await act(async () => button('Add tests').click());
    await flush();
    expect(container.querySelector('.wd-prompts-state-error')?.textContent).toBe('send failed (500)');
  });
});
