// @vitest-environment jsdom
//
// The useSse hook shares one EventSource per URL (ref-counted pool) so a
// review tab — and its ReviewProvider — hold a single browser connection
// instead of one each. These tests drive the hook through real React
// mounts with a fake EventSource to verify sharing, dispatch, and
// teardown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSse, _ssePoolSize } from '../../src/web/src/api/events.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, fn: EventListener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(fn);
  }

  removeEventListener(name: string, fn: EventListener): void {
    this.listeners.get(name)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(name: string, data: string): void {
    for (const fn of this.listeners.get(name) ?? []) {
      fn({ data } as unknown as Event);
    }
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource =
    FakeEventSource;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Subscriber({
  url,
  onPing,
}: {
  url: string | null;
  onPing: (data: unknown) => void;
}) {
  useSse(url, { events: { ping: onPing } });
  return null;
}

function Pair({
  urlA,
  urlB,
  onA,
  onB,
}: {
  urlA: string | null;
  urlB: string | null;
  onA: (d: unknown) => void;
  onB: (d: unknown) => void;
}) {
  return createElement(
    'div',
    null,
    createElement(Subscriber, { url: urlA, onPing: onA }),
    createElement(Subscriber, { url: urlB, onPing: onB }),
  );
}

describe('useSse shared connection pool', () => {
  it('two subscribers to the same URL share one EventSource', () => {
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    act(() => {
      root.render(
        createElement(Pair, {
          urlA: '/events/x',
          urlB: '/events/x',
          onA: (d) => gotA.push(d),
          onB: (d) => gotB.push(d),
        }),
      );
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(_ssePoolSize()).toBe(1);

    // Both subscribers receive a dispatched event (JSON-parsed).
    act(() => {
      FakeEventSource.instances[0].dispatch('ping', '{"n":1}');
    });
    expect(gotA).toEqual([{ n: 1 }]);
    expect(gotB).toEqual([{ n: 1 }]);
  });

  it('different URLs get separate connections', () => {
    act(() => {
      root.render(
        createElement(Pair, {
          urlA: '/events/x',
          urlB: '/events/y',
          onA: () => {},
          onB: () => {},
        }),
      );
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(_ssePoolSize()).toBe(2);
  });

  it('connection closes only when the last subscriber unmounts', () => {
    act(() => {
      root.render(
        createElement(Pair, {
          urlA: '/events/x',
          urlB: '/events/x',
          onA: () => {},
          onB: () => {},
        }),
      );
    });
    const es = FakeEventSource.instances[0];

    // Drop one subscriber (switch its URL to null) — still connected.
    act(() => {
      root.render(
        createElement(Pair, {
          urlA: null,
          urlB: '/events/x',
          onA: () => {},
          onB: () => {},
        }),
      );
    });
    expect(es.closed).toBe(false);
    expect(_ssePoolSize()).toBe(1);

    // Drop the last subscriber — connection closes and leaves the pool.
    act(() => {
      root.render(
        createElement(Pair, {
          urlA: null,
          urlB: null,
          onA: () => {},
          onB: () => {},
        }),
      );
    });
    expect(es.closed).toBe(true);
    expect(_ssePoolSize()).toBe(0);
  });

  it('null URL never connects', () => {
    act(() => {
      root.render(
        createElement(Subscriber, { url: null, onPing: () => {} }),
      );
    });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(_ssePoolSize()).toBe(0);
  });
});
