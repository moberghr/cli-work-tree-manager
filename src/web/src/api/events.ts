import { useEffect } from 'react';

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
 * Handlers may change between renders without disrupting the connection.
 */
export function useSse(url: string | null, handlers: SseHandlers): void {
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(url);
    if (handlers.onOpen) es.addEventListener('open', () => handlers.onOpen!());
    if (handlers.onError) es.addEventListener('error', () => handlers.onError!());
    const subs = Object.entries(handlers.events ?? {}).map(([name, cb]) => {
      const listener = (e: MessageEvent) => {
        let data: unknown = e.data;
        try { data = JSON.parse(e.data); } catch { /* keep raw */ }
        cb(data);
      };
      es.addEventListener(name, listener as EventListener);
      return () => es.removeEventListener(name, listener as EventListener);
    });
    return () => {
      subs.forEach((u) => u());
      es.close();
    };
    // We intentionally only depend on the URL — handlers can change between
    // renders without forcing a reconnect. Pass stable references via
    // useCallback if a handler needs to read fresh state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
}
