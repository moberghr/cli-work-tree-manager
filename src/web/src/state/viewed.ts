/**
 * Per-browser viewed-state for dashboard sessions. Lives in localStorage so
 * "unread Claude comments" survives reloads but not different machines.
 */
const KEY = 'work-web:viewed';

interface ViewedMap {
  /** sessionId → number of claude-authored comments at last viewing. */
  [id: string]: number;
}

function read(): ViewedMap {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ViewedMap) : {};
  } catch {
    return {};
  }
}

function write(map: ViewedMap): void {
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch { /* */ }
}

export function markViewed(sessionId: string, claudeCount: number): void {
  const map = read();
  map[sessionId] = claudeCount;
  write(map);
}

export function getViewed(sessionId: string): number {
  return read()[sessionId] ?? 0;
}

/** Snapshot of viewed counts at a point in time, suitable for use as
 *  React state. Stable identity across calls when nothing changed. */
export function readAllViewed(): ViewedMap {
  return read();
}
