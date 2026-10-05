// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UpdateWire } from '../../src/core/api-types.js';
import { ASK_URL, desktopWire, useDesktop } from '../../src/web/src/hooks/use-desktop.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const w = window as unknown as { __workDesktop?: unknown };
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete w.__workDesktop;
});

let seen: ReturnType<typeof useDesktop> = null;
function Probe({ go }: { go: (url: string) => void }) {
  seen = useDesktop(go);
  return null;
}
const send = (detail: object) => act(() => void window.dispatchEvent(new CustomEvent('work-desktop', { detail })));

describe('useDesktop (the app tells its window, the window asks the app)', () => {
  it('in a browser tab: nothing, and no asks', () => {
    const go = vi.fn();
    act(() => root.render(createElement(Probe, { go })));
    expect(seen).toBeNull();
    expect(go).not.toHaveBeenCalled();
  });

  it("in the app: says hello, follows the app's events, and asks on the app's own host", () => {
    w.__workDesktop = { app: true, update: null };
    const go = vi.fn();
    act(() => root.render(createElement(Probe, { go })));
    expect(go).toHaveBeenCalledWith(`${ASK_URL}hello`);
    expect(seen).toBeNull(); // the updater hasn't said where it stands yet: the server's view
    send({ appVersion: '2.0.2', state: 'downloading', target: '2.0.3', progress: 45 });
    expect(seen!.update).toMatchObject({ state: 'downloading', progress: 45 });
    act(() => seen!.ask('restart'));
    expect(go).toHaveBeenLastCalledWith('http://work-desktop.invalid/restart');
  });

  it('a Check for updates says how it went once the app has looked', () => {
    w.__workDesktop = { app: true, update: { appVersion: '2.0.2', state: 'current' } };
    const go = vi.fn();
    act(() => root.render(createElement(Probe, { go })));
    expect(seen!.update?.state).toBe('current'); // what the app said before the page was up
    act(() => seen!.ask('check'));
    expect(go).toHaveBeenLastCalledWith(`${ASK_URL}check`);
    send({ appVersion: '2.0.2', state: 'checking' });
    expect(seen!.note).toBeNull();
    send({ appVersion: '2.0.2', state: 'current' });
    expect(seen!.note).toBe('You have the newest work (2.0.2).');
  });

  it("a Check asked during a download is answered by the check, not by the download's progress", () => {
    w.__workDesktop = { app: true, update: { appVersion: '2.0.2', state: 'downloading', target: '2.0.3', progress: 10 } };
    act(() => root.render(createElement(Probe, { go: vi.fn() })));
    act(() => seen!.ask('check'));
    const now = Math.floor(Date.now() / 1000);
    send({ appVersion: '2.0.2', state: 'downloading', target: '2.0.3', progress: 60, at: now });
    expect(seen!.note).toBeNull();
    send({ appVersion: '2.0.2', state: 'ready', target: '2.0.3', at: now - 3600 }); // from before the ask
    expect(seen!.note).toBeNull();
    send({ appVersion: '2.0.2', state: 'ready', target: '2.0.3', at: now });
    expect(seen!.note).toBe('work 2.0.3 is out.');
  });

  it('a dev build of the app (no updater) leaves updates to the server', () => {
    w.__workDesktop = { app: true, update: { appVersion: '', state: 'unmanaged' } };
    act(() => root.render(createElement(Probe, { go: vi.fn() })));
    expect(seen).toBeNull();
  });
});

describe('desktopWire', () => {
  const server: UpdateWire = {
    running: '2.0.0',
    install: 'dev',
    latest: '2.0.3',
    checkedAt: null,
    checkError: null,
    desktop: null,
    available: { version: '2.0.3', how: 'command', command: 'git pull' },
    whatsNew: '2.0.0',
  };
  it("the app's version and update, the server's notes; the server's alone until the app says", () => {
    expect(desktopWire(server, null)).toBe(server);
    const v = desktopWire(server, { appVersion: '2.0.2', state: 'ready', target: '2.0.3' })!;
    expect(v).toMatchObject({ running: '2.0.2', install: 'desktop', available: { version: '2.0.3', how: 'restart' }, whatsNew: '2.0.0' });
    // Before work web answered: the app alone.
    expect(desktopWire(null, { appVersion: '2.0.2', state: 'current' })).toMatchObject({ running: '2.0.2', available: null });
  });
});
