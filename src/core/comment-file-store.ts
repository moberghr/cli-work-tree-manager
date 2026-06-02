import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createCommentStore, type CommentInput, type CommentStore } from './comment-store.js';
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
  const file = pathFor(sessionId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(comments, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

const cache = new Map<string, CommentFileStore>();

export function getCommentFileStore(sessionId: string): CommentFileStore {
  const existing = cache.get(sessionId);
  if (existing) return existing;

  const inner = createCommentStore();
  // Seed from disk.
  for (const c of readDisk(sessionId)) {
    // Re-insert via post() would re-assign ids; instead push directly.
    (inner.list() as Comment[]).push(c);
  }

  function persist(): void {
    writeDisk(sessionId, inner.snapshot());
  }

  const store: CommentFileStore = {
    list: () => inner.list(),
    snapshot: () => inner.snapshot(),
    post(input: CommentInput) {
      const c = inner.post(input);
      persist();
      return c;
    },
    remove(id: string) {
      const r = inner.remove(id);
      if (r) persist();
      return r;
    },
    submit(summary: string | undefined) {
      const result = inner.submit(summary);
      persist();
      return result;
    },
    discardDrafts() {
      const n = inner.discardDrafts();
      if (n > 0) persist();
      return n;
    },
    reload() {
      const list = inner.list() as Comment[];
      list.length = 0;
      for (const c of readDisk(sessionId)) list.push(c);
    },
  };
  cache.set(sessionId, store);
  return store;
}

/** Clear the in-memory cache. Test/server-shutdown hook. */
export function clearCommentStoreCache(): void {
  cache.clear();
}
