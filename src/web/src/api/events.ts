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
 * Subscribe to a Server-Sent Events stream for the duration of a component's
 * lifetime. The URL is dependency-tracked: when it changes (e.g. switching
 * sessions), the previous connection is closed and a fresh one opens.
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
    const es = new EventSource(url);
    es.addEventListener('open', () => ref.current.onOpen?.());
    es.addEventListener('error', () => ref.current.onError?.());

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
      subs.forEach((u) => u());
      es.close();
    };
    // We intentionally only depend on the URL — handlers can change between
    // renders without forcing a reconnect, since dispatch goes through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
}
