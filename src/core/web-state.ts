import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { loadHistory, type WorktreeSession } from './history.js';
import { sessionIdFor } from './session-id.js';

export { sessionIdFor } from './session-id.js';

export function findSession(sessionId: string): WorktreeSession | null {
  return loadHistory().find((s) => sessionIdFor(s) === sessionId) ?? null;
}

interface WatcherEntry {
  watcher: FSWatcher;
  subscribers: Set<() => void>;
  debounce: NodeJS.Timeout | null;
}

const sessionWatchers = new Map<string, WatcherEntry>();
const DEBOUNCE_MS = 150;

/**
 * Subscribe to filesystem changes for a session's worktree(s). chokidar is
 * started on first subscriber and stopped when the last one leaves —
 * reference-counted so the cost stays proportional to what's actually being
 * viewed in the browser.
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
    const roots = session.paths;
    const watcher = chokidar.watch(roots, {
      ignored: (filePath) => {
        for (const r of roots) {
          const rel = path.relative(r, filePath).replace(/\\/g, '/');
          if (rel === '.git' || rel.startsWith('.git/')) return true;
        }
        return false;
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });
    const newEntry: WatcherEntry = {
      watcher,
      subscribers: new Set(),
      debounce: null,
    };
    watcher.on('all', () => {
      if (newEntry.debounce) clearTimeout(newEntry.debounce);
      newEntry.debounce = setTimeout(() => {
        newEntry.debounce = null;
        for (const cb of newEntry.subscribers) {
          try { cb(); } catch { /* swallow */ }
        }
      }, DEBOUNCE_MS);
    });
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
      if (entry!.debounce) clearTimeout(entry!.debounce);
      entry!.watcher.close().catch(() => { /* */ });
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
  if (entry.debounce) clearTimeout(entry.debounce);
  entry.subscribers.clear();
  await entry.watcher.close().catch(() => { /* */ });
}

/** Stop every active session watcher. Called on server shutdown. */
export function disposeAllWatchers(): void {
  for (const [, entry] of sessionWatchers) {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.watcher.close().catch(() => { /* */ });
  }
  sessionWatchers.clear();
}
