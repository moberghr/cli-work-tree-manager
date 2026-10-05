// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UpdateWire } from '../../src/core/api-types.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { UpdateStrip } = await import('../../src/web/src/components/Dashboard/UpdateStrip.js');
const { WhatsNew } = await import('../../src/web/src/components/Dashboard/WhatsNew.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
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
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);
const wire = (over: Partial<UpdateWire>): UpdateWire => ({
  running: '2.0.0',
  install: 'desktop',
  latest: '2.1.0',
  checkedAt: null,
  checkError: null,
  desktop: null,
  available: null,
  whatsNew: null,
  ...over,
});

describe('UpdateStrip', () => {
  it('Restart says it is installing: the app closes and comes back, the Claudes keep running', () => {
    const props = {
      updates: wire({ available: { version: '2.1.0', how: 'restart' } }),
      onRestart: vi.fn(async () => ({})),
      onWhatsNew: vi.fn(),
    };
    act(() => root.render(createElement(UpdateStrip, props)));
    act(() => button('Restart')!.click());
    expect(props.onRestart).toHaveBeenCalled();
    expect(container.textContent).toContain('Installing work 2.1.0…');
    expect(container.textContent).toContain('The app closes and comes back in a few seconds. Your Claudes keep running.');
    // A bar that moves without a number: the install can't be counted from here.
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.classList.contains('wd-update-bar-moving')).toBe(true);
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
  });

  it('downloading in the app: how far, with a bar; you can keep working', () => {
    act(() =>
      root.render(
        createElement(UpdateStrip, {
          updates: wire({ available: { version: '2.0.3', how: 'downloading', progress: 45 } }),
          onRestart: vi.fn(),
          onWhatsNew: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain('Downloading work 2.0.3 · 45%');
    expect(container.textContent).toContain('You can keep working; it installs when you restart.');
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('45');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('45%');
    expect(button('Restart')).toBeUndefined();
  });

  it('ready: says what Restart does', () => {
    act(() =>
      root.render(
        createElement(UpdateStrip, {
          updates: wire({ available: { version: '2.0.3', how: 'restart' } }),
          onRestart: vi.fn(),
          onWhatsNew: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain('The app closes and comes back on 2.0.3 in a few seconds. Your Claudes keep running.');
  });

  it('Restart from Help (restarting) says so too, even after Later hid the card', () => {
    const props = {
      updates: wire({ available: { version: '2.1.0', how: 'restart' } }),
      onRestart: vi.fn(async () => ({})),
      onWhatsNew: vi.fn(),
    };
    act(() => root.render(createElement(UpdateStrip, props)));
    act(() => button('Later')!.click());
    expect(container.textContent).toBe('');
    act(() => root.render(createElement(UpdateStrip, { ...props, restarting: true })));
    expect(container.textContent).toContain('Installing work 2.1.0');
  });

  it('nothing without an update', () => {
    act(() => root.render(createElement(UpdateStrip, { updates: wire({}), onRestart: vi.fn(), onWhatsNew: vi.fn() })));
    expect(container.textContent).toBe('');
  });

  it('the desktop app has it: Restart, and What’s new; Later hides it until a newer one', async () => {
    const onRestart = vi.fn(async () => ({ ok: true }));
    const onWhatsNew = vi.fn();
    const props = { updates: wire({ available: { version: '2.1.0', how: 'restart' } }), onRestart, onWhatsNew };
    act(() => root.render(createElement(UpdateStrip, props)));
    expect(container.textContent).toContain('work 2.1.0 is ready.');
    act(() => button('What’s new')?.click() ?? button("What's new")!.click());
    expect(onWhatsNew).toHaveBeenCalled();
    act(() => button('Later')!.click());
    expect(container.textContent).toBe('');
    // A newer one shows again.
    act(() => root.render(createElement(UpdateStrip, { ...props, updates: wire({ available: { version: '2.2.0', how: 'restart' } }) })));
    expect(container.textContent).toContain('work 2.2.0 is ready.');
  });

  it('npm or a git checkout: the command to run, which Copy copies; a failed restart says why', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    const command = 'npm install -g @moberg_hr/work-tree@latest';
    act(() =>
      root.render(
        createElement(UpdateStrip, {
          updates: wire({ available: { version: '2.1.0', how: 'command', command } }),
          onRestart: vi.fn(),
          onWhatsNew: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector('code')!.textContent).toBe(command);
    expect(button('Restart')).toBeUndefined();
    act(() => button('Copy')!.click());
    await flush();
    expect(writeText).toHaveBeenCalledWith(command);
    expect(button('Copied')).toBeDefined();

    const refused = vi.fn(async () => Promise.reject(new Error('No downloaded update to restart into.')));
    act(() =>
      root.render(
        createElement(UpdateStrip, {
          updates: wire({ available: { version: '2.3.0', how: 'restart' } }),
          onRestart: refused,
          onWhatsNew: vi.fn(),
        }),
      ),
    );
    act(() => button('Restart')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('No downloaded update');
  });
});

describe('WhatsNew', () => {
  it('every release’s notes, newest first, opened on the one given; links open outside', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const load = async () => ({
      releases: [
        {
          version: '2.1.0',
          name: 'work 2.1.0',
          body: '- [Jira](https://example.com/jira) has its own tab',
          publishedAt: '2026-10-05T00:00:00Z',
          url: '',
        },
        { version: '2.0.0', name: 'work 2.0.0', body: '', publishedAt: '', url: '' },
      ],
      checkError: null,
    });
    const onClose = vi.fn();
    act(() => root.render(createElement(WhatsNew, { focus: '2.1.0', onClose, load })));
    await flush();
    expect(container.querySelector('h2')!.textContent).toBe('What’s new in work 2.1.0'.replace('’', "'"));
    expect([...container.querySelectorAll('h3')].map((h) => h.textContent?.split(' ').slice(0, 2).join(' '))).toEqual([
      'work 2.1.0',
      'work 2.0.0',
    ]);
    expect(container.querySelector('.wd-whats-new-focus')!.getAttribute('data-version')).toBe('2.1.0');
    expect(container.textContent).toContain('No notes written.');
    act(() => container.querySelector('a')!.click());
    expect(open).toHaveBeenCalledWith('https://example.com/jira', '_blank', 'noopener');
    act(() => (container.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalled();
    open.mockRestore();
  });

  it('no notes, or GitHub not answering: says so', async () => {
    act(() => root.render(createElement(WhatsNew, { onClose: vi.fn(), load: async () => ({ releases: [], checkError: 'offline' }) })));
    await flush();
    expect(container.textContent).toContain('offline');
  });
});
