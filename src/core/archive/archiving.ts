/**
 * Sessions being archived right now (archiveSession, from its first step to
 * its last). Nothing may start their Claude meanwhile: archiving stops it
 * first, and a Terminal tab still open on the session would otherwise start
 * it again a moment later — an archived session with a live Claude, put back
 * by the PTY host after every restart. ensurePty refuses them, and archived
 * ones (pty-pool.ts).
 *
 * In memory, per process: archiving runs in work web, which is also what
 * starts session Claudes.
 */

const inProgress = new Set<string>();
/** Restores running now: every view lists the session again at once, as Restoring. */
const restoring = new Set<string>();
type Change = (sessionId: string, what: 'archiving' | 'restoring', on: boolean) => void;
const listeners = new Set<Change>();

/** Told when a session starts and stops being archived or restored (work web broadcasts it: the rail shows it). Returns the unsubscribe. */
export function onArchivingChange(listener: Change): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tell(sessionId: string, what: 'archiving' | 'restoring', on: boolean): void {
  for (const l of listeners) {
    try {
      l(sessionId, what, on);
    } catch {
      // A listener's trouble is never the archive's.
    }
  }
}

export function isRestoring(sessionId: string): boolean {
  return restoring.has(sessionId);
}

/** Run `fn` (a Restore) with the session marked as being restored. */
export async function whileRestoring<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  restoring.add(sessionId);
  tell(sessionId, 'restoring', true);
  try {
    return await fn();
  } finally {
    restoring.delete(sessionId);
    tell(sessionId, 'restoring', false);
  }
}

export function isArchiving(sessionId: string): boolean {
  return inProgress.has(sessionId);
}

/** Run `fn` with the session marked as being archived. */
export async function whileArchiving<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  inProgress.add(sessionId);
  tell(sessionId, 'archiving', true);
  try {
    return await fn();
  } finally {
    inProgress.delete(sessionId);
    tell(sessionId, 'archiving', false);
  }
}

/** Why a session's Claude can't be started now, or null. */
export function noClaudeBecause(session: { archivedAt?: string | null } | null, sessionId: string): string | null {
  if (isArchiving(sessionId)) return 'This session is being archived.';
  if (session?.archivedAt) return 'This session is archived. Restore it to continue the conversation.';
  return null;
}
