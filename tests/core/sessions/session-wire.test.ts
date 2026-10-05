import { describe, expect, it, vi } from 'vitest';
import type { WorktreeSession } from '../../../src/core/sessions/history.js';

// The folder's own signals, as readSessionMeta would find them: Claude wrote
// a moment ago (so "active"), no hook status.
vi.mock('../../../src/core/sessions/session-meta.js', () => ({
  readSessionMeta: () => ({
    draftCount: 0,
    commentCount: 0,
    claudeCount: 0,
    ptyStatus: 'idle',
    pendingForClaudeCount: 0,
    lastActivity: 1_700_000_000_000,
    activityState: 'stale',
    attention: null,
  }),
}));
vi.mock('../../../src/core/conversations/context-usage.js', () => ({ readContextUsage: () => null }));

import { reviewThreadsOf, sessionWire } from '../../../src/core/sessions/session-wire.js';
import { OUTPUT_WORKING_MS, statusFromOutput } from '../../../src/core/pty/output-status.js';

const s = {
  target: 'work-tree',
  branch: 'main',
  isGroup: false,
  paths: ['/repo/work-tree'],
  createdAt: '2026-09-01T00:00:00Z',
  lastAccessedAt: '2026-09-01T00:00:00Z',
} as WorktreeSession;

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
    expect(
      reviewThreadsOf({
        repos: [{ pr: pr('OPEN'), openThreads: 2 }, { pr: pr('OPEN'), openThreads: 1 }, { pr: pr('MERGED'), openThreads: 4 }, { pr: null }],
      }),
    ).toBe(3);
    expect(reviewThreadsOf(null)).toBe(0);
  });

  it("an entry sharing its folder with the folder's owner gets none of its activity", () => {
    const w = sessionWire(s, { shadowed: () => true, claudesFor: () => ({ inTerminal: 1, inApp: 0, busy: true, duplicate: false }) });
    expect(w).toMatchObject({ activityState: 'stale', lastActivity: null });
    expect(w.claudes).toBeUndefined();
  });

  it('a tool with no hooks gets its status from its terminal output — never over a hook status, an archive or a shadow', () => {
    const working = statusFromOutput({ tool: 'opencode', lastOutputAt: new Date().toISOString(), startedAt: '' }, Date.now());
    expect(sessionWire(s, { outputStatusFor: () => working }).attention).toMatchObject({ state: 'working', seen: true });
    expect(sessionWire({ ...s, archivedAt: '2026-09-02T00:00:00Z' }, { outputStatusFor: () => working }).attention).toBeNull();
    expect(sessionWire(s, { shadowed: () => true, outputStatusFor: () => working }).attention).toBeNull();
  });
});

describe('statusFromOutput (pure)', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  it('working while it prints, idle once quiet; nothing for Claude (hooks) or no output yet', () => {
    expect(statusFromOutput({ tool: 'opencode', lastOutputAt: at(2_000), startedAt: '' }, now)?.state).toBe('working');
    expect(statusFromOutput({ tool: 'opencode', lastOutputAt: at(OUTPUT_WORKING_MS + 1), startedAt: '' }, now)).toMatchObject({
      state: 'idle',
      seen: true,
    });
    expect(statusFromOutput({ tool: 'claude', lastOutputAt: at(0), startedAt: '' }, now)).toBeNull();
    expect(statusFromOutput({ lastOutputAt: at(0), startedAt: '' }, now)).toBeNull(); // an older host: no tool
    expect(statusFromOutput({ tool: 'opencode', startedAt: '' }, now)).toBeNull();
  });
});
