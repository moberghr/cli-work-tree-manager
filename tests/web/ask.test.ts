// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AskHost } from '../../src/web/src/components/AskHost.js';
import { ask } from '../../src/web/src/state/ask.js';
import { modalOpen } from '../../src/web/src/state/modal-open.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(AskHost)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const dialog = () => container.querySelector<HTMLElement>('[role="alertdialog"]');
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('ask: the page asks, never window.confirm (the macOS desktop app has none)', () => {
  it('shows the question in the page and resolves with the answer', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    let yes!: Promise<boolean>;
    act(() => void (yes = ask('Start it here?\n\nBoth would write.', { ok: 'Start it here' })));
    expect(dialog()!.textContent).toContain('Start it here?');
    expect(modalOpen()).toBe(true); // the shortcuts stop while it asks
    expect(document.activeElement).toBe(button('Start it here'));
    act(() => button('Start it here').click());
    await expect(yes).resolves.toBe(true);
    expect(dialog()).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('Cancel, Esc and a click outside say no', async () => {
    let no!: Promise<boolean>;
    act(() => void (no = ask('Archive?')));
    act(() => button('Cancel').click());
    await expect(no).resolves.toBe(false);

    act(() => void (no = ask('Archive?')));
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await expect(no).resolves.toBe(false);

    act(() => void (no = ask('Archive?')));
    act(() => {
      container.querySelector('.wd-ask-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await expect(no).resolves.toBe(false);
  });

  it("its Esc doesn't reach a modal under it", () => {
    const under = vi.fn();
    document.addEventListener('keydown', under);
    act(() => void ask('Discard all 2 pending comment(s)?'));
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    document.removeEventListener('keydown', under);
    expect(under).not.toHaveBeenCalled();
  });

  it('two questions show one at a time, in order', async () => {
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = ask('First?');
      second = ask('Second?');
    });
    expect(dialog()!.textContent).toContain('First?');
    act(() => button('OK').click());
    expect(dialog()!.textContent).toContain('Second?');
    act(() => button('Cancel').click());
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it('a question left when the host goes is answered no', async () => {
    let q!: Promise<boolean>;
    act(() => void (q = ask('Leave?')));
    act(() => root.unmount());
    await expect(q).resolves.toBe(false);
    root = createRoot(container); // for afterEach
  });
});
