import { describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../src/core/history.js';

// The folder's own signals, as readSessionMeta would find them: Claude wrote
// a moment ago (so "active"), no hook status.
vi.mock('../../src/core/session-meta.js', () => ({
  readSessionMeta: () => ({
    draftCount: 0, commentCount: 0, claudeCount: 0, ptyStatus: 'idle', pendingForClaudeCount: 0,
    lastActivity: 1_700_000_000_000, activityState: 'stale', attention: null,
  }),
}));
vi.mock('../../src/core/context-usage.js', () => ({ readContextUsage: () => null }));

import { reviewThreadsOf, sessionWire } from '../../src/core/session-wire.js';

const s = { target: 'work-tree', branch: 'main', isGroup: false, paths: ['/repo/work-tree'], createdAt: '2026-09-01T00:00:00Z', lastAccessedAt: '2026-09-01T00:00:00Z' } as WorktreeSession;

describe('sessionWire', () => {
  it('a running Claude makes a quiet session open, and busy makes it active', () => {
    const idle = { inTerminal: 1, inApp: 0, busy: false, duplicate: false };
    expect(sessionWire(s, { claudesFor: () => idle })).toMatchObject({ activityState: 'open', claudes: idle });
    expect(sessionWire(s, { claudesFor: () => ({ ...idle, busy: true }) }).activityState).toBe('active');
    expect(sessionWire(s, {}).claudes).toBeUndefined();
  });

  it('carries the unresolved review threads of its open PRs, never for an archived session', () => {
    expect(sessionWire(s, { reviewThreadsFor: () => 3 }).openReviewThreads).toBe(3);
    expect(sessionWire(s, { reviewThreadsFor: () => 0 }).openReviewThreads).toBeUndefined();
    expect(sessionWire({ ...s, archivedAt: '2026-09-02T00:00:00Z' }, { reviewThreadsFor: () => 3 }).openReviewThreads).toBeUndefined();
    const pr = (state: string) => ({ state });
    expect(reviewThreadsOf({ repos: [{ pr: pr('OPEN'), openThreads: 2 }, { pr: pr('OPEN'), openThreads: 1 }, { pr: pr('MERGED'), openThreads: 4 }, { pr: null }] })).toBe(3);
    expect(reviewThreadsOf(null)).toBe(0);
  });

  it("an entry sharing its folder with the folder's owner gets none of its activity", () => {
    const w = sessionWire(s, { shadowed: () => true, claudesFor: () => ({ inTerminal: 1, inApp: 0, busy: true, duplicate: false }) });
    expect(w).toMatchObject({ activityState: 'stale', lastActivity: null });
    expect(w.claudes).toBeUndefined();
  });
});
