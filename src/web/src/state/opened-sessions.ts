/**
 * Persistent LRU window of session IDs the user has opened in the
 * dashboard. Drives the keep-mounted-hidden navigation in DashboardApp
 * AND the "Active" pinned group at the top of the sidebar.
 *
 * Persisted to localStorage so a page reload doesn't drop the user's
 * working set. Capped — the cap is the same as DashboardApp's
 * MAX_OPEN_SESSIONS; if they ever diverge, prefer DashboardApp's number.
 */
const KEY = 'work-web:opened-sessions';
const MAX = 10;

export function readOpened(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as unknown[])
      .filter((v): v is string => typeof v === 'string')
      .slice(-MAX);
  } catch {
    return [];
  }
}

export function writeOpened(ids: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX)));
  } catch { /* */ }
}

export const MAX_OPEN_SESSIONS = MAX;
