// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { presenceReport, showNotify, usePresence } from '../../src/web/src/hooks/use-presence.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in for the browser Notification API. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static shown: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => FakeNotification.permission);
  onclick: (() => void) | null = null;
  closed = false;
  constructor(public title: string, public opts: NotificationOptions) {
    FakeNotification.shown.push(this);
  }
  close() {
    this.closed = true;
  }
}

let focused = true;
beforeEach(() => {
  FakeNotification.shown = [];
  FakeNotification.permission = 'granted';
  vi.stubGlobal('Notification', FakeNotification);
  focused = true;
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ev = { sessionId: 's1', kind: 'needs_input' as const, title: 'Needs your input — api · feat/x', body: 'use Bash?' };

describe('showNotify', () => {
  it('raises a tagged notification that jumps to the session on click', () => {
    const open = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const n = showNotify(ev, 'other', open) as unknown as FakeNotification;
    expect(n.title).toBe(ev.title);
    expect(n.opts).toMatchObject({ body: 'use Bash?', tag: 'work-s1' });
    n.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith('s1', 'needs_input');
    expect(n.closed).toBe(true);
  });

  it('stays quiet while this tab is focused on that session', () => {
    expect(showNotify(ev, 's1', vi.fn())).toBeNull();
    focused = false;
    expect(showNotify(ev, 's1', vi.fn())).not.toBeNull();
  });

  it('does nothing without permission', () => {
    FakeNotification.permission = 'default';
    expect(showNotify(ev, 'other', vi.fn())).toBeNull();
  });
});

describe('usePresence', () => {
  let container: HTMLDivElement;
  let root: Root;
  let posts: Array<Record<string, unknown>>;
  beforeEach(() => {
    posts = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(init.body as string));
      return new Response('{}');
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function Probe({ id }: { id: string | null }) {
    usePresence(id);
    return null;
  }

  it('reports what the tab shows, again on change and on blur, and says goodbye', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    await act(async () => root.render(createElement(Probe, { id: 's1' })));
    expect(posts.at(-1)).toMatchObject({ sessionId: 's1', focused: true, canNotify: true });
    const clientId = posts[0].clientId;

    await act(async () => root.render(createElement(Probe, { id: null })));
    expect(posts.at(-1)).toMatchObject({ sessionId: null, clientId });

    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(posts.at(-1)).toMatchObject({ focused: false });

    window.dispatchEvent(new Event('pagehide'));
    expect(JSON.parse(beacon.mock.calls.at(-1)![1] as string)).toMatchObject({ clientId, gone: true });
  });

  it('one id per tab', () => {
    expect(presenceReport(null).clientId).toBe(presenceReport('x').clientId);
  });
});
