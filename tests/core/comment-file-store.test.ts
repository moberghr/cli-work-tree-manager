import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  clearCommentStoreCache,
  commentsDir,
  commentsFileFor,
  getCommentFileStore,
} from '../../src/core/comment-file-store.js';

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

describe('comment-file-store', () => {
  it('commentsDir() resolves under the mocked homedir', () => {
    expect(
      commentsDir().toLowerCase().startsWith(tmpDir.toLowerCase()),
    ).toBe(true);
  });

  it('commentsFileFor returns a path under commentsDir()', () => {
    const p = commentsFileFor('abc123');
    expect(p).toBe(path.join(commentsDir(), 'abc123.json'));
  });

  it('persists posts to disk and rehydrates on next get', () => {
    const a = getCommentFileStore('sid');
    const c1 = a.post({ body: 'hi' });
    expect(fs.existsSync(commentsFileFor('sid'))).toBe(true);

    // Force a fresh load by clearing the in-process cache.
    clearCommentStoreCache();
    const b = getCommentFileStore('sid');
    const reloaded = b.snapshot();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(c1.id);
    expect(reloaded[0].body).toBe('hi');
  });

  it('returns the same instance for the same session id (cache)', () => {
    const a = getCommentFileStore('sid');
    const b = getCommentFileStore('sid');
    expect(a).toBe(b);
  });

  it('writes atomically (tmp-then-rename)', () => {
    const s = getCommentFileStore('sid');
    s.post({ body: 'x' });
    // No leftover tmp files in the comments dir.
    const stragglers = fs
      .readdirSync(commentsDir())
      .filter((n) => n.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });

  it('snapshot() bypasses cache only via clearCommentStoreCache + getCommentFileStore', () => {
    // External writes are picked up via reload() — confirm reload reads
    // fresh bytes from disk.
    const s = getCommentFileStore('sid');
    s.post({ body: 'one' });
    // Tamper with the file directly.
    const file = commentsFileFor('sid');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    onDisk.push({
      id: 'manual',
      repo: '',
      file: '',
      line: 0,
      side: 'general',
      body: 'inserted out-of-band',
      createdAt: new Date().toISOString(),
      author: 'user',
      status: 'published',
    });
    fs.writeFileSync(file, JSON.stringify(onDisk));
    // Cache still shows the old snapshot.
    expect(s.snapshot()).toHaveLength(1);
    // Reload picks up the external write.
    s.reload();
    expect(s.snapshot()).toHaveLength(2);
  });

  it('remove() persists the deletion', () => {
    const s = getCommentFileStore('sid');
    const c = s.post({ body: 'x' });
    expect(s.remove(c.id)).toBe(true);
    clearCommentStoreCache();
    const s2 = getCommentFileStore('sid');
    expect(s2.snapshot()).toHaveLength(0);
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

  it('does not clobber a concurrent out-of-band append on the next write', () => {
    // Simulates the cross-process lost-update: `work web` holds a store and
    // posts a comment, then a SEPARATE process (e.g. `work broadcast`) appends
    // a comment straight to the file on disk. The next `work web` post must
    // reload-under-lock and preserve the broadcast comment rather than
    // persisting its stale in-memory snapshot over it.
    const s = getCommentFileStore('sid');
    const a = s.post({ body: 'from web A' });

    // Out-of-band append straight to disk (mimics the broadcast process,
    // which writes under the same advisory lock).
    const file = commentsFileFor('sid');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    onDisk.push({
      id: 'broadcast-1',
      repo: '',
      file: '',
      line: 0,
      side: 'general',
      body: 'from broadcast',
      createdAt: new Date().toISOString(),
      author: 'user',
      status: 'published',
    });
    fs.writeFileSync(file, JSON.stringify(onDisk));

    // The in-memory store is now stale (still only knows about A). Posting a
    // new comment must NOT drop the broadcast comment.
    const c = s.post({ body: 'from web C' });

    clearCommentStoreCache();
    const reloaded = getCommentFileStore('sid').snapshot();
    const bodies = reloaded.map((x) => x.body).sort();
    expect(bodies).toEqual(['from broadcast', 'from web A', 'from web C']);
    // Ids preserved for both web comments.
    expect(reloaded.find((x) => x.id === a.id)?.body).toBe('from web A');
    expect(reloaded.find((x) => x.id === c.id)?.body).toBe('from web C');
  });

  it('a remove() reloads first so it does not resurrect or drop concurrent comments', () => {
    const s = getCommentFileStore('sid');
    const a = s.post({ body: 'A' });

    // Concurrent out-of-band append.
    const file = commentsFileFor('sid');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    onDisk.push({
      id: 'broadcast-1',
      repo: '',
      file: '',
      line: 0,
      side: 'general',
      body: 'from broadcast',
      createdAt: new Date().toISOString(),
      author: 'user',
      status: 'published',
    });
    fs.writeFileSync(file, JSON.stringify(onDisk));

    // Remove A — the broadcast comment must remain on disk afterwards.
    expect(s.remove(a.id)).toBe(true);

    clearCommentStoreCache();
    const reloaded = getCommentFileStore('sid').snapshot();
    expect(reloaded.map((x) => x.body)).toEqual(['from broadcast']);
  });
});
