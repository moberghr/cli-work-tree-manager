import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findSessionForCwd,
  formatPendingForPrompt,
  markDelivered,
  readPendingForSession,
  readPendingForWorktree,
} from '../../src/core/pending-delivery.js';
import {
  clearCommentStoreCache,
  getCommentFileStore,
} from '../../src/core/comment-file-store.js';
import { scopeHashFor } from '../../src/core/repo-spec.js';
import { sessionIdFor } from '../../src/core/web-state.js';
import { saveHistory, type WorktreeSession } from '../../src/core/history.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-pd-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  clearCommentStoreCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCommentStoreCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function session(over: Partial<WorktreeSession> = {}): WorktreeSession {
  return {
    target: 'repo',
    isGroup: false,
    branch: 'feat/x',
    paths: ['C:/work/repo'],
    createdAt: '2026-01-01T00:00:00Z',
    lastAccessedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('findSessionForCwd', () => {
  it('matches the exact session path', () => {
    saveHistory([session({ paths: ['C:/work/repo'] })]);
    const s = findSessionForCwd('C:/work/repo');
    expect(s?.branch).toBe('feat/x');
  });

  it('matches a subdirectory of a session path', () => {
    saveHistory([session({ paths: ['C:/work/repo'] })]);
    const s = findSessionForCwd('C:/work/repo/src/sub');
    expect(s?.branch).toBe('feat/x');
  });

  it('picks the longest-prefix match for nested worktrees', () => {
    saveHistory([
      session({ branch: 'outer', paths: ['C:/work/outer'] }),
      session({ branch: 'nested', paths: ['C:/work/outer/nested'] }),
    ]);
    const s = findSessionForCwd('C:/work/outer/nested/lib');
    expect(s?.branch).toBe('nested');
  });

  it('returns null when no session matches', () => {
    saveHistory([session({ paths: ['C:/work/repo'] })]);
    expect(findSessionForCwd('C:/totally/elsewhere')).toBeNull();
  });

  it('handles Windows-style backslashes vs forward slashes consistently', () => {
    saveHistory([session({ paths: ['C:\\work\\repo'] })]);
    expect(findSessionForCwd('C:/work/repo')).not.toBeNull();
    expect(findSessionForCwd('C:\\work\\repo')).not.toBeNull();
  });
});

describe('readPendingForSession + markDelivered', () => {
  it('filters to published, user-authored, undelivered comments', () => {
    const store = getCommentFileStore('sid');
    const p1 = store.post({ body: 'one' }); // published user
    store.post({ body: 'draft', status: 'draft' }); // draft → excluded
    store.post({ body: 'claude reply', author: 'claude' }); // claude → excluded
    const p2 = store.post({ body: 'two' });

    const pending = readPendingForSession('sid');
    expect(pending.map((c) => c.id).sort()).toEqual([p1.id, p2.id].sort());
  });

  it('markDelivered persists ids so they are not returned again', () => {
    const store = getCommentFileStore('sid');
    const c = store.post({ body: 'one' });
    expect(readPendingForSession('sid')).toHaveLength(1);
    markDelivered('sid', [c.id]);
    expect(readPendingForSession('sid')).toHaveLength(0);
  });

  it('markDelivered with empty array is a no-op', () => {
    markDelivered('sid', []);
    // No file should be created.
    const deliveredPath = path.join(
      tmpDir,
      '.work',
      'comments',
      'sid.delivered.json',
    );
    expect(fs.existsSync(deliveredPath)).toBe(false);
  });

  it('only the new comments come back after delivery + new posts', () => {
    const store = getCommentFileStore('sid');
    const first = store.post({ body: 'one' });
    markDelivered('sid', [first.id]);
    const second = store.post({ body: 'two' });
    const pending = readPendingForSession('sid');
    expect(pending.map((c) => c.id)).toEqual([second.id]);
  });

  it('markDelivered is idempotent for repeated ids', () => {
    const store = getCommentFileStore('sid');
    const c = store.post({ body: 'one' });
    markDelivered('sid', [c.id]);
    markDelivered('sid', [c.id]);
    markDelivered('sid', [c.id]);
    const deliveredPath = path.join(
      tmpDir,
      '.work',
      'comments',
      'sid.delivered.json',
    );
    const arr = JSON.parse(fs.readFileSync(deliveredPath, 'utf-8'));
    expect(arr).toEqual([c.id]);
  });
});

describe('readPendingForWorktree (session + wd scope bridge)', () => {
  // `wd` stores its review comments under a scope-hash store, not the
  // session store. The hook must surface those too, otherwise comments
  // left in the `wd` review UI never reach the Claude in that worktree.
  // Use a POSIX-absolute path so it's stable under `path.resolve` (which
  // production applies before hashing). Windows-style 'C:/...' would be
  // treated as relative on the test host.
  const WT = '/work/repo';
  // Mirror production's hash derivation (resolve then hash).
  function scopeStoreIdFor(paths: string[]): string {
    return `scope-${scopeHashFor(paths.map((p) => path.resolve(p)))}`;
  }

  it('surfaces comments left in a wd scope store for the worktree', () => {
    const s = session({ paths: [WT] });
    const scopeStore = getCommentFileStore(scopeStoreIdFor([WT]));
    const c = scopeStore.post({ body: 'from wd review' });
    const pending = readPendingForWorktree(s);
    expect(pending.map((x) => x.id)).toEqual([c.id]);
  });

  it('merges session-store and scope-store comments', () => {
    const s = session({ paths: [WT] });
    const sessionStore = getCommentFileStore(sessionIdFor(s));
    const a = sessionStore.post({ body: 'dashboard comment' });
    const scopeStore = getCommentFileStore(scopeStoreIdFor([WT]));
    const b = scopeStore.post({ body: 'wd comment' });
    const pending = readPendingForWorktree(s);
    expect(pending.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('respects the per-session delivered set for scope comments', () => {
    const s = session({ paths: [WT] });
    const scopeStore = getCommentFileStore(scopeStoreIdFor([WT]));
    const c = scopeStore.post({ body: 'wd comment' });
    expect(readPendingForWorktree(s)).toHaveLength(1);
    markDelivered(sessionIdFor(s), [c.id]);
    expect(readPendingForWorktree(s)).toHaveLength(0);
  });

  it('does not pull in another worktree’s scope comments', () => {
    const s = session({ paths: [WT] });
    const otherScope = getCommentFileStore(scopeStoreIdFor(['/work/other']));
    otherScope.post({ body: 'belongs to a different worktree' });
    expect(readPendingForWorktree(s)).toHaveLength(0);
  });
});

describe('formatPendingForPrompt', () => {
  it('returns empty string for empty input', () => {
    expect(formatPendingForPrompt([])).toBe('');
  });

  it('groups general / inline / reply comments under headings', () => {
    const store = getCommentFileStore('sid');
    const top = store.post({
      body: 'inline note',
      repo: 'r',
      file: 'a.ts',
      line: 5,
      side: 'right',
    });
    store.post({ body: 'overall', side: 'general' });
    store.post({ body: 'response', parentId: top.id });
    const out = formatPendingForPrompt(readPendingForSession('sid'));
    expect(out).toContain('<system-reminder>');
    expect(out).toContain('## General notes');
    expect(out).toContain('## Inline comments');
    expect(out).toContain('## Replies');
    expect(out).toContain('r/a.ts:5');
    expect(out).toContain('</system-reminder>');
  });

  it('delivers multi-line general (broadcast) bodies in full, not just line 1', () => {
    const store = getCommentFileStore('sid');
    store.post({ body: 'line one\nline two\nline three', side: 'general' });
    const out = formatPendingForPrompt(readPendingForSession('sid'));
    expect(out).toContain('line one');
    expect(out).toContain('line two');
    expect(out).toContain('line three');
  });

  it('keeps inline comments compacted to their first line', () => {
    const store = getCommentFileStore('sid');
    store.post({
      body: 'headline\nsecond line should be dropped for inline',
      repo: 'r',
      file: 'a.ts',
      line: 3,
      side: 'right',
    });
    const out = formatPendingForPrompt(readPendingForSession('sid'));
    expect(out).toContain('headline');
    expect(out).not.toContain('second line should be dropped for inline');
  });

  it('truncates pathologically long bodies', () => {
    const store = getCommentFileStore('sid');
    const huge = 'x'.repeat(10_000);
    store.post({ body: huge });
    const out = formatPendingForPrompt(readPendingForSession('sid'));
    // Should NOT contain the full 10k body — capped at ~4 KB plus ellipsis.
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('xxxxx');
    expect(out).toContain('…');
  });
});
