import { useSyncExternalStore } from 'react';

/**
 * Archives and restores in flight, by session id: `true` archiving, `false`
 * restoring. Kept outside any component, so a button shows "Archiving…" for
 * as long as it runs — also after you went to another session and came back
 * (the button is a new component then; its own state said "Archive" while
 * the session was about to disappear). setArchived records every call here.
 */

const pending = new Map<string, boolean>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const l of listeners) l();
};

export function trackArchive<T>(sessionId: string, archiving: boolean, work: Promise<T>): Promise<T> {
  pending.set(sessionId, archiving);
  changed();
  const done = () => {
    if (pending.get(sessionId) === archiving) pending.delete(sessionId);
    changed();
  };
  work.then(done, done);
  return work;
}

/** `true` while it is being archived, `false` while being restored, else undefined. */
export function archivePending(sessionId: string): boolean | undefined {
  return pending.get(sessionId);
}

export function useArchivePending(sessionId: string): boolean | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pending.get(sessionId),
  );
}
