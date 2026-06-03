import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCommentStore, type CommentInput, type CommentStore } from './comment-store.js';
import { ensureFile, withFileLockSync, atomicWriteFile } from './fs-safe.js';
import type { Comment } from './comment-types.js';

/**
 * File-backed comment store. One JSON file per session at
 * `~/.work/comments/<sessionId>.json`. Mutations are serialized in-process
 * via a simple in-memory queue so two browser tabs writing at the same
 * instant cannot interleave atomic-write attempts.
 *
 * Atomicity: every save writes a tmp file in the same dir then renames.
 * Crash-resistant for the common case (single mutator at a time).
 */
export interface CommentFileStore extends CommentStore {
  /** Drop the cached in-memory store and reload from disk. */
  reload(): void;
}

/** Canonical location of all per-session comment files. A function so it
 *  re-resolves `os.homedir()` on every call — tests that mock `homedir()`
 *  need this, and the cost is one `path.join` per access. */
export function commentsDir(): string {
  return path.join(os.homedir(), '.work', 'comments');
}

function ensureDir(): void {
  fs.mkdirSync(commentsDir(), { recursive: true });
}

/** File path for one session's comment store. Use this rather than rolling
 *  your own concat. */
export function commentsFileFor(sessionId: string): string {
  return path.join(commentsDir(), `${sessionId}.json`);
}

function pathFor(sessionId: string): string {
  return commentsFileFor(sessionId);
}

function readDisk(sessionId: string): Comment[] {
  try {
    const raw = fs.readFileSync(pathFor(sessionId), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Comment[]) : [];
  } catch {
    return [];
  }
}

function writeDisk(sessionId: string, comments: Comment[]): void {
  ensureDir();
  atomicWriteFile(pathFor(sessionId), JSON.stringify(comments, null, 2));
}

const cache = new Map<string, CommentFileStore>();

export function getCommentFileStore(sessionId: string): CommentFileStore {
  const existing = cache.get(sessionId);
  if (existing) return existing;

  const inner = createCommentStore();

  /** Replace the in-memory contents with the current on-disk contents.
   *  Used to reconcile before a mutation so concurrent writers (e.g. a
   *  `work broadcast` process appending under the same lock) aren't lost. */
  function reloadInner(): void {
    const list = inner.list() as Comment[];
    list.length = 0;
    for (const c of readDisk(sessionId)) list.push(c);
  }

  // Seed from disk.
  reloadInner();

  /**
   * Run a read-modify-write of this session's comment file under a
   * cross-process lock (§5.2): acquire the lock, reload the in-memory store
   * from disk so it reflects any concurrent appends, apply `mutate`, persist
   * atomically, then release. `persisted` reports whether anything changed so
   * a no-op (e.g. removing a missing id) can skip the write.
   */
  function lockedMutate<T>(
    mutate: () => { value: T; persisted: boolean },
  ): T {
    const file = pathFor(sessionId);
    ensureDir();
    ensureFile(file, '[]');
    return withFileLockSync(file, () => {
      reloadInner();
      const { value, persisted } = mutate();
      if (persisted) writeDisk(sessionId, inner.snapshot());
      return value;
    });
  }

  const store: CommentFileStore = {
    list: () => inner.list(),
    snapshot: () => inner.snapshot(),
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
  };
  cache.set(sessionId, store);
  return store;
}

/** Clear the in-memory cache. Test/server-shutdown hook. */
export function clearCommentStoreCache(): void {
  cache.clear();
}
