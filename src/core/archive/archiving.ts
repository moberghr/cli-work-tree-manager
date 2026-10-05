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

export function isArchiving(sessionId: string): boolean {
  return inProgress.has(sessionId);
}

/** Run `fn` with the session marked as being archived. */
export async function whileArchiving<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  inProgress.add(sessionId);
  try {
    return await fn();
  } finally {
    inProgress.delete(sessionId);
  }
}

/** Why a session's Claude can't be started now, or null. */
export function noClaudeBecause(session: { archivedAt?: string | null } | null, sessionId: string): string | null {
  if (isArchiving(sessionId)) return 'This session is being archived.';
  if (session?.archivedAt) return 'This session is archived. Restore it to continue the conversation.';
  return null;
}
