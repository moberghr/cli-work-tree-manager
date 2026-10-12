import type { WorktreeSession } from '../sessions/history.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { readStoresComments } from './comment-file-store.js';
import { scopeStoreIdsForPaths } from './pending-delivery.js';
import type { Comment } from './comment-types.js';

/**
 * One worktree's comments live in two kinds of store: the session's own (the
 * dashboard's Diff tab posts there) and a `wd` scope's (`scope-<hash>`: the
 * browser diff page, `/diff/<hash>`, posts there). Claude was handed both
 * (`readPendingForWorktree`), but each view showed only its own, so a comment
 * made on one wasn't there on the other. Each view now lists its own store
 * first and the linked ones after: the session's view its scope stores, a
 * scope's view the session(s) whose worktree it covers.
 *
 * The stores stay separate — a new `wd -c` run clears its scope's comments
 * (`ensureScope`), which must never clear the session's.
 */

/** A session as these lookups need it: its id (its store's) and its worktree paths. */
export interface LinkedSession {
  id: string;
  paths: string[];
}

export const linkedSession = (s: WorktreeSession): LinkedSession => ({ id: sessionIdFor(s), paths: s.paths });

/** The session's store, then every scope store over its paths. */
export function sessionLinkedStoreIds(session: LinkedSession): string[] {
  return [session.id, ...scopeStoreIdsForPaths(session.paths)];
}

/** The scope's store, then each session whose paths that scope covers (the whole worktree, or one repo of a group). */
export function scopeLinkedStoreIds(hash: string, sessions: LinkedSession[]): string[] {
  const own = `scope-${hash}`;
  return [own, ...new Set(sessions.filter((s) => scopeStoreIdsForPaths(s.paths).includes(own)).map((s) => s.id))];
}

export type Read = (storeId: string) => Comment[];

/** These stores read in one query (they're mostly empty: a scope store has rows only once its page was commented on). */
export function readerFor(storeIds: string[]): Read {
  const rows = readStoresComments(storeIds);
  return (id) => rows.get(id) ?? [];
}

/**
 * Every comment the view shows: the first store's whole, the linked ones'
 * without their drafts (a draft is that view's unsent review; this view's
 * Submit wouldn't send it). Oldest first, each comment once.
 */
export function linkedComments(storeIds: string[], read: Read = readerFor(storeIds)): Comment[] {
  const seen = new Set<string>();
  const out: Comment[] = [];
  storeIds.forEach((id, i) => {
    for (const c of read(id)) {
      if (seen.has(c.id) || (i > 0 && c.status === 'draft')) continue;
      seen.add(c.id);
      out.push(c);
    }
  });
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Which of these stores holds the comment (a delete, a resolve or a reply acts there), or null. */
export function storeHolding(storeIds: string[], commentId: string, read: Read = readerFor(storeIds)): string | null {
  return storeIds.find((id) => read(id).some((c) => c.id === commentId)) ?? null;
}

/** Who to tell a store changed: the sessions and scopes whose views list it. */
export function viewersOf(storeId: string, sessions: LinkedSession[]): { sessionIds: string[]; scopeHashes: string[] } {
  if (storeId.startsWith('scope-')) {
    return {
      sessionIds: [...new Set(sessions.filter((s) => scopeStoreIdsForPaths(s.paths).includes(storeId)).map((s) => s.id))],
      scopeHashes: [storeId.slice('scope-'.length)],
    };
  }
  const session = sessions.find((s) => s.id === storeId);
  return {
    sessionIds: [storeId],
    scopeHashes: session ? scopeStoreIdsForPaths(session.paths).map((id) => id.slice('scope-'.length)) : [],
  };
}

/** How a front-end tells a view its comments changed: a session's Diff tab by id, a scope page on its own stream. */
export interface Tell {
  session: (sessionId: string, data: Record<string, unknown>) => void;
  scope: (scopeHash: string, data: Record<string, unknown>) => void;
}

/** A store changed: every view listing it is told (both comment routes use this, so they can't drift apart). */
export function announceChange(storeId: string, sessions: LinkedSession[], tell: Tell, data: Record<string, unknown>): void {
  const { sessionIds, scopeHashes } = viewersOf(storeId, sessions);
  for (const sessionId of sessionIds) tell.session(sessionId, { ...data, sessionId });
  for (const scopeHash of scopeHashes) tell.scope(scopeHash, { ...data, scopeHash });
}
