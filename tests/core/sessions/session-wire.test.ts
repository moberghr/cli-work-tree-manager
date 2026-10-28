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

import { reviewThreadsOf, sessionWire, wireRepos } from '../../../src/core/sessions/session-wire.js';
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
  it('isAsleep: work stopped its Claude while idle and it has not run since; started again (running, or written since): awake', async () => {
    const { isAsleep } = await import('../../../src/core/sessions/session-wire.js');
    const stopped = '2026-10-28T15:00:00Z';
    expect(isAsleep(stopped, false, Date.parse('2026-10-28T14:50:00Z'))).toBe(true);
    expect(isAsleep(stopped, true, 0)).toBe(false); // running again
    expect(isAsleep(stopped, false, Date.parse('2026-10-28T15:02:00Z'))).toBe(false); // wrote since (a terminal outside)
    expect(isAsleep(undefined, false, 0)).toBe(false); // never stopped by work
  });

  it('behindFor is told its agent last wrote, so one entered long ago but worked in today counts as in use', () => {
    const behindFor = vi.fn(() => null);
    sessionWire(s, { behindFor });
    expect(behindFor).toHaveBeenCalledWith(expect.any(String), s, expect.any(Number));
  });

  it('says when it is being archived, only while it is', async () => {
    const { whileArchiving } = await import('../../../src/core/archive/archiving.js');
    const { sessionIdFor } = await import('../../../src/core/sessions/web-state.js');
    expect(sessionWire(s).archiving).toBeUndefined();
    let during: unknown;
    await whileArchiving(sessionIdFor(s), async () => {
      during = sessionWire(s).archiving;
    });
    expect(during).toBe(true);
    expect(sessionWire(s).archiving).toBeUndefined();
  });

  it('withRestoring marks a row Restoring while its Restore runs, on a copy (archived rows are cached)', async () => {
    const { whileRestoring } = await import('../../../src/core/archive/archiving.js');
    const { withRestoring } = await import('../../../src/core/sessions/session-wire.js');
    const row = sessionWire({ ...s, archivedAt: '2026-09-02T00:00:00Z' });
    expect(withRestoring(row)).toBe(row);
    let during: ReturnType<typeof withRestoring> | null = null;
    await whileRestoring(row.id, async () => {
      during = withRestoring(row);
    });
    expect(during).toMatchObject({ id: row.id, restoring: true, archivedAt: '2026-09-02T00:00:00Z' });
    expect(row.restoring).toBeUndefined();
    expect(withRestoring(row)).toBe(row);
  });

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

describe('its repos on the wire', () => {
  const group = {
    ...s,
    target: 'shop',
    isGroup: true,
    paths: ['/wt/shop/feat-x/backend-repo', '/wt/shop/feat-x/frontend', '/wt/shop/feat-x/docs'],
  } as WorktreeSession;
  const config = { repos: { backend: '/src/backend-repo', frontend: '/src/frontend' }, groups: { shop: ['backend', 'frontend'] } };

  it('a single repo: its target, not a folder', () => {
    expect(sessionWire(s)).toMatchObject({ repos: ['work-tree'], folder: false });
  });

  it('a recorded list as recorded (a repo its group lacks included), a folder; no config read', () => {
    const config = vi.fn(() => null);
    const recorded = { ...group, repos: ['backend', 'frontend', 'docs'] };
    expect(wireRepos(recorded, config)).toEqual(['backend', 'frontend', 'docs']);
    expect(config).not.toHaveBeenCalled();
    expect(sessionWire(recorded)).toMatchObject({ repos: ['backend', 'frontend', 'docs'], folder: true });
  });

  it("a group's row from before: its config members by folder name, else the folder's name", () => {
    expect(wireRepos(group, () => config)).toEqual(['backend', 'frontend', 'docs']);
    expect(wireRepos(group, () => null)).toEqual(['backend-repo', 'frontend', 'docs']);
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
