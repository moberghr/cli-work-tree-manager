import { createFsWatcher, type FsWatcher } from '../platform/fs-watcher.js';
import { findSessionById, type WorktreeSession } from './history.js';

export { sessionIdFor } from './session-id.js';

/** A session by id — a primary-key lookup (every /api/sessions/:id/*
 *  request does one; it used to load and hash every row). */
export function findSession(sessionId: string): WorktreeSession | null {
  return findSessionById(sessionId);
}

interface WatcherEntry {
  watcher: FsWatcher;
  subscribers: Set<() => void>;
}

const sessionWatchers = new Map<string, WatcherEntry>();
const DEBOUNCE_MS = 150;

/**
 * Subscribe to filesystem changes for a session's worktree(s). The watch is
 * started on first subscriber and stopped when the last one leaves —
 * reference-counted so the cost stays proportional to what's actually being
 * viewed in the browser. It is the shared fs-watcher: dependency and build
 * folders (node_modules, bin/obj, dist, …) are left out, and on Windows and
 * macOS it is one recursive OS watch per root. A chokidar watch over the
 * whole worktree used to open one watch per folder, node_modules included.
 *
 * Returns an unsubscribe function. Safe to call multiple times.
 */
export function subscribeSession(
  sessionId: string,
  onChange: () => void,
): () => void {
  const session = findSession(sessionId);
  if (!session) return () => { /* unknown session */ };

  let entry = sessionWatchers.get(sessionId);
  if (!entry) {
    const subscribers = new Set<() => void>();
    const newEntry: WatcherEntry = {
      subscribers,
      watcher: createFsWatcher({
        roots: session.paths,
        debounceMs: DEBOUNCE_MS,
        onChange: () => {
          for (const cb of subscribers) {
            try { cb(); } catch { /* swallow */ }
          }
        },
      }),
    };
    sessionWatchers.set(sessionId, newEntry);
    entry = newEntry;
  }

  entry.subscribers.add(onChange);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry!.subscribers.delete(onChange);
    if (entry!.subscribers.size === 0) {
      entry!.watcher.stop();
      if (sessionWatchers.get(sessionId) === entry) {
        sessionWatchers.delete(sessionId);
      }
    }
  };
}

/**
 * Force-stop one session's watcher regardless of subscribers. Used before
 * removing a worktree: on Windows an open directory watch keeps a handle
 * on the tree and makes `git worktree remove` fail. Late unsubscribes from
 * the orphaned entry are harmless (see the identity check above).
 */
export async function disposeSessionWatcher(sessionId: string): Promise<void> {
  const entry = sessionWatchers.get(sessionId);
  if (!entry) return;
  sessionWatchers.delete(sessionId);
  entry.subscribers.clear();
  entry.watcher.stop();
}

/** Stop every active session watcher. Called on server shutdown. */
export function disposeAllWatchers(): void {
  for (const [, entry] of sessionWatchers) entry.watcher.stop();
  sessionWatchers.clear();
}
