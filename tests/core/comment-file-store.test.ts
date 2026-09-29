import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  clearCommentStoreCache,
  getCommentFileStore,
  readStoreComments,
} from '../../src/core/comment-file-store.js';
import { withDb } from '../../src/core/db.js';
import type { Comment } from '../../src/core/comment-types.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cfs-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  clearCommentStoreCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCommentStoreCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Another process (e.g. `work broadcast`) writing to the same store. */
function writeFromElsewhere(store: string, id: string, body: string): void {
  const c: Comment = {
    id,
    repo: '',
    file: '',
    line: 0,
    side: 'general',
    body,
    createdAt: new Date().toISOString(),
    author: 'user',
    status: 'published',
  };
  withDb((d) => d.prepare('INSERT INTO comments (store, id, data) VALUES (?, ?, ?)').run(store, id, JSON.stringify(c)));
}

describe('comment-file-store', () => {
  it('persists posts and rehydrates on next get', () => {
    const a = getCommentFileStore('sid');
    const c1 = a.post({ body: 'hi' });

    // Force a fresh load by clearing the in-process cache.
    clearCommentStoreCache();
    const reloaded = getCommentFileStore('sid').snapshot();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(c1.id);
    expect(reloaded[0].body).toBe('hi');
  });

  it('keeps stores apart', () => {
    getCommentFileStore('one').post({ body: 'a' });
    getCommentFileStore('two').post({ body: 'b' });
    expect(readStoreComments('one').map((c) => c.body)).toEqual(['a']);
    expect(readStoreComments('two').map((c) => c.body)).toEqual(['b']);
  });

  it('keeps comments in the order they were posted', () => {
    const s = getCommentFileStore('sid');
    for (const b of ['1', '2', '3']) s.post({ body: b });
    clearCommentStoreCache();
    expect(getCommentFileStore('sid').snapshot().map((c) => c.body)).toEqual(['1', '2', '3']);
  });

  it('returns the same instance for the same session id (cache)', () => {
    const a = getCommentFileStore('sid');
    const b = getCommentFileStore('sid');
    expect(a).toBe(b);
  });

  it('the cached snapshot is stale until reload(); readStoreComments is always current', () => {
    const s = getCommentFileStore('sid');
    s.post({ body: 'one' });
    writeFromElsewhere('sid', 'manual', 'inserted by another process');
    expect(s.snapshot()).toHaveLength(1);
    expect(readStoreComments('sid')).toHaveLength(2);
    s.reload();
    expect(s.snapshot()).toHaveLength(2);
  });

  it('remove() persists the deletion', () => {
    const s = getCommentFileStore('sid');
    const c = s.post({ body: 'x' });
    expect(s.remove(c.id)).toBe(true);
    clearCommentStoreCache();
    expect(getCommentFileStore('sid').snapshot()).toHaveLength(0);
  });

  it('discardDrafts() persists the change', () => {
    const s = getCommentFileStore('sid');
    s.post({ body: 'draft', status: 'draft' });
    s.post({ body: 'pub' });
    s.discardDrafts();
    clearCommentStoreCache();
    const s2 = getCommentFileStore('sid');
    expect(s2.snapshot()).toHaveLength(1);
    expect(s2.snapshot()[0].body).toBe('pub');
  });

  it('does not clobber a concurrent write from another process on the next write', () => {
    // The cross-process lost update: work web holds a store and posts, then
    // a SEPARATE process (e.g. `work broadcast`) adds a comment. The next
    // work web post must reload inside its transaction and keep it, rather
    // than persisting its stale in-memory snapshot over it.
    const s = getCommentFileStore('sid');
    const a = s.post({ body: 'from web A' });
    writeFromElsewhere('sid', 'broadcast-1', 'from broadcast');

    const c = s.post({ body: 'from web C' });

    clearCommentStoreCache();
    const reloaded = getCommentFileStore('sid').snapshot();
    expect(reloaded.map((x) => x.body).sort()).toEqual(['from broadcast', 'from web A', 'from web C']);
    expect(reloaded.find((x) => x.id === a.id)?.body).toBe('from web A');
    expect(reloaded.find((x) => x.id === c.id)?.body).toBe('from web C');
  });

  it('a remove() reloads first so it does not resurrect or drop concurrent comments', () => {
    const s = getCommentFileStore('sid');
    const a = s.post({ body: 'A' });
    writeFromElsewhere('sid', 'broadcast-1', 'from broadcast');

    expect(s.remove(a.id)).toBe(true);

    clearCommentStoreCache();
    expect(getCommentFileStore('sid').snapshot().map((x) => x.body)).toEqual(['from broadcast']);
  });

  it('skips a stored row that is not a comment instead of failing', () => {
    withDb((d) => d.prepare('INSERT INTO comments (store, id, data) VALUES (?, ?, ?)').run('sid', 'bad', '{"nope":1}'));
    getCommentFileStore('sid').post({ body: 'ok' });
    clearCommentStoreCache();
    expect(getCommentFileStore('sid').snapshot().map((c) => c.body)).toEqual(['ok']);
  });
});

describe('clearAll', () => {
  it('removes every comment and reports the count', () => {
    const s = getCommentFileStore('sid-clear');
    s.post({ body: 'one' });
    s.post({ body: 'two' });
    expect(s.clearAll()).toBe(2);
    expect(s.list()).toHaveLength(0);
    expect(readStoreComments('sid-clear')).toEqual([]);
  });

  it('is a no-op on an empty store', () => {
    const s = getCommentFileStore('sid-clear-empty');
    expect(s.clearAll()).toBe(0);
    expect(s.list()).toHaveLength(0);
  });
});
