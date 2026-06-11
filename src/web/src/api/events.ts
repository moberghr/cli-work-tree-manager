import { useEffect, useRef } from 'react';
import { isStaticMode } from './client.js';

export interface SseHandlers {
  /** Called once when the EventSource opens. */
  onOpen?: () => void;
  /** Map of event name → handler. Data is parsed as JSON if possible. */
  events?: Record<string, (data: unknown) => void>;
  /** Called on EventSource error. EventSource auto-reconnects; this is
   *  informational only. */
  onError?: () => void;
}

/**
 * Shared, ref-counted EventSource pool keyed by URL.
 *
 * Browsers cap concurrent connections per host (~6 on HTTP/1.1), and every
 * EventSource pins one for its whole lifetime. Multiple components — and
 * multiple open tabs' worth of components — subscribing to the same stream
 * each used to open their own connection; a few review tabs could exhaust
 * the pool and leave every subsequent fetch queued forever ("infinite
 * loading"). Sharing one EventSource per URL caps each page at one
 * connection per distinct stream.
 */
const esPool = new Map<string, { es: EventSource; refs: number }>();

function acquireEventSource(url: string): EventSource {
  let entry = esPool.get(url);
  if (!entry) {
    entry = { es: new EventSource(url), refs: 0 };
    esPool.set(url, entry);
  }
  entry.refs++;
  return entry.es;
}

function releaseEventSource(url: string): void {
  const entry = esPool.get(url);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    entry.es.close();
    esPool.delete(url);
  }
}

/** Test hook: number of live pooled connections. */
export function _ssePoolSize(): number {
  return esPool.size;
}

/**
 * Subscribe to a Server-Sent Events stream for the duration of a component's
 * lifetime. The URL is dependency-tracked: when it changes (e.g. switching
 * sessions), the previous subscription is released and a fresh one acquired.
 * Subscriptions to the same URL share one underlying EventSource (see pool
 * note above); pass `null` to disconnect entirely.
 *
 * Handlers may change between renders without disrupting the connection —
 * dispatch goes through a ref so listeners always read the freshest version.
 *
 * In static-file mode there is no server to talk to; this becomes a no-op.
 */
export function useSse(url: string | null, handlers: SseHandlers): void {
  // Keep the latest handlers in a ref so listeners registered on the [url]
  // effect always dispatch through fresh handler references, avoiding the
  // stale-closure bug where handlers were captured only on first run.
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    if (!url) return;
    if (isStaticMode()) return;
    const es = acquireEventSource(url);
    const onOpen = () => ref.current.onOpen?.();
    const onError = () => ref.current.onError?.();
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);

    // Register a listener for every event name we've ever seen. The set of
    // event names is expected to be stable across renders; the handler bodies
    // are read fresh from the ref on each dispatch.
    const names = Object.keys(ref.current.events ?? {});
    const subs = names.map((name) => {
      const listener = (e: MessageEvent) => {
        let data: unknown = e.data;
        try { data = JSON.parse(e.data); } catch { /* keep raw */ }
        ref.current.events?.[name]?.(data);
      };
      es.addEventListener(name, listener as EventListener);
      return () => es.removeEventListener(name, listener as EventListener);
    });
    return () => {
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      subs.forEach((u) => u());
      releaseEventSource(url);
    };
    // We intentionally only depend on the URL — handlers can change between
    // renders without forcing a reconnect, since dispatch goes through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
}
