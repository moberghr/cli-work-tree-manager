import { useMemo, useSyncExternalStore } from 'react';

/**
 * Archives and restores in flight, by session id: `true` archiving, `false`
 * restoring. Kept outside any component, so a button shows "Archiving…" for
 * as long as it runs — also after you went to another session and came back
 * (the button is a new component then; its own state said "Archive" while
 * the session was about to disappear). setArchived records every call here.
 */

const pending = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const l of listeners) l();
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
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
  return useSyncExternalStore(subscribe, () => pending.get(sessionId));
}

type Marked = { id: string; archiving?: boolean; restoring?: boolean };

/**
 * The rows with `archiving` / `restoring` set on the ones this window is
 * archiving or restoring, so every view shows it the moment you click — a
 * restored one back in the rail at once. The server says so too
 * (SessionWire.archiving / restoring, for one started anywhere), a moment
 * later. The same array when nothing changes.
 */
export function markArchiving<T extends Marked>(rows: T[], pendingFor: (id: string) => boolean | undefined = archivePending): T[] {
  const mark = (r: T): T => {
    const p = pendingFor(r.id);
    if (p === true && !r.archiving) return { ...r, archiving: true };
    if (p === false && !r.restoring) return { ...r, restoring: true };
    return r;
  };
  const out = rows.map(mark);
  return out.every((r, i) => r === rows[i]) ? rows : out;
}

export function useMarkArchiving<T extends Marked>(rows: T[]): T[] {
  const v = useSyncExternalStore(subscribe, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `v` is the pending map's version: a change re-marks the rows.
  return useMemo(() => markArchiving(rows), [rows, v]);
}
