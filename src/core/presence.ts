import type { PresenceReport } from './api-types.js';

/**
 * Who is looking at the dashboard, so a session event notifies the user
 * only when they aren't already watching it.
 *
 * Each open dashboard tab reports (POST /api/presence) which session it
 * shows, whether it is visible and focused, and whether it may show
 * browser notifications — on every change plus a heartbeat. A tab that
 * stops reporting (closed, crashed, laptop asleep) ages out after
 * PRESENCE_TTL_MS.
 *
 * Pure: time comes from the injected clock.
 */

export const PRESENCE_TTL_MS = 45_000;

/** Where a session event should notify:
 *  - 'none'    someone is looking at that very session right now
 *  - 'browser' a dashboard tab can raise a click-to-jump notification
 *  - 'os'      no dashboard can — fall back to the desktop toast */
export type NotifyRoute = 'none' | 'browser' | 'os';

export interface Presence {
  report(r: PresenceReport): void;
  drop(clientId: string): void;
  route(sessionId: string): NotifyRoute;
  /** Live tabs (for tests / diagnostics). */
  live(): PresenceReport[];
}

export function createPresence(now: () => number = Date.now): Presence {
  const clients = new Map<string, PresenceReport & { at: number }>();
  const live = () => {
    const cutoff = now() - PRESENCE_TTL_MS;
    for (const [id, c] of clients) if (c.at < cutoff) clients.delete(id);
    return [...clients.values()];
  };
  return {
    report(r) {
      clients.set(r.clientId, { ...r, at: now() });
    },
    drop(clientId) {
      clients.delete(clientId);
    },
    route(sessionId) {
      const tabs = live();
      if (tabs.some((t) => t.visible && t.focused && t.sessionId === sessionId)) return 'none';
      if (tabs.some((t) => t.canNotify)) return 'browser';
      return 'os';
    },
    live: () => live().map(({ at: _at, ...r }) => r),
  };
}
