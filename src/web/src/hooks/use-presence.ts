import { useCallback, useEffect, useState } from 'react';
import type { NotifyEvent, PresenceReport } from '../api/client.js';

/**
 * Notification discipline, browser side.
 *
 * usePresence tells work web what this tab shows (session, visible,
 * focused, may notify) on every change plus a heartbeat, so the server
 * notifies only when nobody is looking at that session — and routes it
 * here as a click-to-jump browser notification instead of a desktop toast
 * whenever a tab can show one.
 */

const HEARTBEAT_MS = 15_000;
/** Ask the presence hook to report now (e.g. after permission changed). */
const REFRESH_EVENT = 'wd-presence-refresh';

let clientId: string | null = null;
function tabId(): string {
  if (!clientId) {
    clientId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  return clientId;
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}
function canNotify(): boolean {
  return notificationsSupported() && Notification.permission === 'granted';
}
function looking(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function presenceReport(sessionId: string | null): PresenceReport {
  return {
    clientId: tabId(),
    sessionId,
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    canNotify: canNotify(),
  };
}

function send(body: PresenceReport, beacon = false): void {
  const json = JSON.stringify(body);
  try {
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/presence', json);
      return;
    }
    void fetch('/api/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* best-effort */
  }
}

export function usePresence(sessionId: string | null): void {
  useEffect(() => {
    const report = () => send(presenceReport(sessionId));
    report();
    const beat = setInterval(report, HEARTBEAT_MS);
    const gone = () => send({ ...presenceReport(sessionId), gone: true }, true);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    window.addEventListener(REFRESH_EVENT, report);
    window.addEventListener('pagehide', gone);
    return () => {
      clearInterval(beat);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      window.removeEventListener(REFRESH_EVENT, report);
      window.removeEventListener('pagehide', gone);
    };
  }, [sessionId]);
}

/**
 * Show a server `notify` event as a browser notification; clicking it
 * focuses the dashboard on that session. Skipped when this tab is the one
 * the user is looking at, on that session (the server already checked, but
 * focus may have moved since). Tagged per session so several open tabs
 * collapse into one notification.
 */
export function showNotify(
  ev: NotifyEvent,
  currentSessionId: string | null,
  open: (sessionId: string, kind: NotifyEvent['kind']) => void,
): Notification | null {
  if (!canNotify()) return null;
  if (looking() && currentSessionId === ev.sessionId) return null;
  const n = new Notification(ev.title, { body: ev.body ?? '', tag: `work-${ev.sessionId}` });
  n.onclick = () => {
    window.focus();
    open(ev.sessionId, ev.kind);
    n.close();
  };
  return n;
}

/** The permission prompt must come from a click. */
export function useNotificationPermission(): {
  state: NotificationPermission | 'unsupported';
  request: () => void;
} {
  const [state, setState] = useState<NotificationPermission | 'unsupported'>(() =>
    notificationsSupported() ? Notification.permission : 'unsupported',
  );
  const request = useCallback(() => {
    if (!notificationsSupported()) return;
    void Notification.requestPermission().then((p) => {
      setState(p);
      window.dispatchEvent(new Event(REFRESH_EVENT));
    });
  }, []);
  return { state, request };
}
