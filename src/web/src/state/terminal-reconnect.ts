/**
 * "Reconnect terminal" (the session's ⋯ menu, ⇧R): the header asks, the
 * session's Terminal (PtyView, its own lazily loaded chunk) does it — a new
 * connection, which attaches to its Claude again, or starts it (resuming the
 * conversation) when none runs. For a tab whose connection went stale
 * without saying so: its screen takes no input.
 */
export const TERMINAL_RECONNECT_EVENT = 'work:terminal-reconnect';

export function requestTerminalReconnect(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<{ id: string }>(TERMINAL_RECONNECT_EVENT, { detail: { id: sessionId } }));
}

/** Call `reconnect` when this session's terminal is asked to reconnect; returns the unsubscribe. */
export function onTerminalReconnect(sessionId: string, reconnect: () => void): () => void {
  const on = (e: Event) => {
    if ((e as CustomEvent<{ id: string }>).detail?.id === sessionId) reconnect();
  };
  window.addEventListener(TERMINAL_RECONNECT_EVENT, on);
  return () => window.removeEventListener(TERMINAL_RECONNECT_EVENT, on);
}
