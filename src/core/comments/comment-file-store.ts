import { createCommentStore, type CommentInput, type CommentStore } from './comment-store.js';
import { json, tx, withDb, type Db } from '../platform/db.js';
import type { Comment } from './comment-types.js';

/**
 * Persistent comment store: the pure in-memory model (comment-store.ts)
 * over state.db's `comments` table, one "store" per session id (or
 * `scope-<hash>` for a `wd` review). Every mutation runs in a write
 * transaction that first reloads the store from the database, so
 * concurrent writers in other processes (`work broadcast`, the hook, a
 * second work web tab) are never lost.
 *
 * (The name is historical: this used to be one JSON file per store.)
 */
export interface CommentFileStore extends CommentStore {
  /** Drop the cached in-memory store and reload from disk. */
  reload(): void;
  /** Remove every comment (memory + disk). Returns how many were removed.
   *  Used when a finished scope review is re-registered — the new run
   *  starts from a clean slate instead of replaying the old comments. */
  clearAll(): number;
}

function isComment(x: unknown): x is Comment {
  const c = x as Comment | null;
  return !!c && typeof c === 'object' && typeof c.id === 'string' && typeof c.body === 'string';
}

function readRows(d: Db, store: string): Comment[] {
  return (d.prepare('SELECT data FROM comments WHERE store = ? ORDER BY rowid').all(store) as Array<{ data: string }>)
    .map((r) => json.parse(r.data))
    .filter(isComment);
}

/** Replace a store's rows with `comments` (in their order). */
function writeRows(d: Db, store: string, comments: Comment[]): void {
  d.prepare('DELETE FROM comments WHERE store = ?').run(store);
  const ins = d.prepare('INSERT OR REPLACE INTO comments (store, id, data) VALUES (?, ?, ?)');
  for (const c of comments) ins.run(store, c.id, JSON.stringify(c));
}

/** A store's comments straight from the database: current even when
 *  another process wrote since this process cached the store. */
export function readStoreComments(store: string): Comment[] {
  return withDb((d) => readRows(d, store));
}

const cache = new Map<string, CommentFileStore>();

export function getCommentFileStore(sessionId: string): CommentFileStore {
  const existing = cache.get(sessionId);
  if (existing) return existing;

  const inner = createCommentStore();

  /** Replace the in-memory contents with the current on-disk contents.
   *  Used to reconcile before a mutation so concurrent writers (e.g. a
   *  `work broadcast` process appending under the same lock) aren't lost. */
  function reloadFrom(rows: Comment[]): void {
    const list = inner.list() as Comment[];
    list.length = 0;
    for (const c of rows) list.push(c);
  }
  function reloadInner(): void {
    reloadFrom(withDb((d) => readRows(d, sessionId)));
  }

  // Seed from the database.
  reloadInner();

  /**
   * A read-modify-write of this store in one write transaction: reload the
   * in-memory model from the database (so it reflects other processes'
   * writes), apply `mutate`, persist. `persisted` reports whether anything
   * changed, so a no-op (e.g. removing a missing id) skips the write.
   */
  function lockedMutate<T>(
    mutate: () => { value: T; persisted: boolean },
  ): T {
    return tx((d) => {
      reloadFrom(readRows(d, sessionId));
      const { value, persisted } = mutate();
      if (persisted) writeRows(d, sessionId, inner.snapshot());
      return value;
    });
  }

  const store: CommentFileStore = {
    // Reads reload first (one indexed query): `work broadcast` and the
    // hooks write to the same store from other processes, and a list
    // served from this process's memory didn't show them until something
    // here mutated. The in-memory model is for mutations, not a cache.
    list: () => {
      reloadInner();
      return inner.list();
    },
    snapshot: () => {
      reloadInner();
      return inner.snapshot();
    },
    post(input: CommentInput) {
      return lockedMutate(() => {
        const c = inner.post(input);
        return { value: c, persisted: true };
      });
    },
    remove(id: string) {
      return lockedMutate(() => {
        const r = inner.remove(id);
        return { value: r, persisted: r };
      });
    },
    setResolved(id: string, resolved: boolean) {
      return lockedMutate(() => {
        const c = inner.setResolved(id, resolved);
        return { value: c, persisted: c !== null };
      });
    },
    submit(summary: string | undefined) {
      return lockedMutate(() => {
        const result = inner.submit(summary);
        return { value: result, persisted: true };
      });
    },
    discardDrafts() {
      return lockedMutate(() => {
        const n = inner.discardDrafts();
        return { value: n, persisted: n > 0 };
      });
    },
    reload() {
      reloadInner();
    },
    clearAll() {
      return lockedMutate(() => {
        const list = inner.list() as Comment[];
        const n = list.length;
        list.length = 0;
        return { value: n, persisted: n > 0 };
      });
    },
  };
  cache.set(sessionId, store);
  return store;
}

/** Clear the in-memory cache. Test/server-shutdown hook. */
export function clearCommentStoreCache(): void {
  cache.clear();
}
