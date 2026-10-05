import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSessionMeta } from '../../../src/core/sessions/session-meta.js';
import { clearCommentStoreCache, getCommentFileStore } from '../../../src/core/comments/comment-file-store.js';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-meta-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  clearCommentStoreCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearCommentStoreCache();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const session: WorktreeSession = {
  target: 'api',
  branch: 'feat/x',
  isGroup: false,
  paths: ['/nowhere/api'],
  createdAt: 'x',
  lastAccessedAt: 'x',
};

describe('readSessionMeta', () => {
  it("the Diff tab's badge counts open threads: not resolved ones, not replies", () => {
    const store = getCommentFileStore('s1');
    const open = store.post({ body: 'rename this' });
    const done = store.post({ body: 'New review feedback on GitHub …' });
    store.setResolved(done.id, true);
    store.post({ body: 'renamed', author: 'claude', parentId: open.id });
    store.post({ body: 'still writing', status: 'draft' });
    expect(readSessionMeta('s1', session)).toMatchObject({ commentCount: 2, draftCount: 1, claudeCount: 1 });
  });
});
