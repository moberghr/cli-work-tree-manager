import { describe, it, expect } from 'vitest';
import { buildSidebarRows } from '../../src/tui-ink/Sidebar.js';
import type { WorktreeSession } from '../../src/core/history.js';

function makeSession(target: string, branch: string, isGroup = false): WorktreeSession {
  return {
    target,
    branch,
    isGroup,
    paths: ['/tmp/test'],
    lastAccessedAt: Date.now(),
  };
}

describe('buildSidebarRows', () => {
  it('returns empty array for empty sessions', () => {
    expect(buildSidebarRows([])).toEqual([]);
  });

  it('groups sessions by target with headers', () => {
    const sessions = [
      makeSession('api', 'feature-a'),
      makeSession('api', 'feature-b'),
      makeSession('frontend', 'main'),
    ];
    const rows = buildSidebarRows(sessions);

    expect(rows).toHaveLength(5); // 2 headers + 3 sessions
    expect(rows[0]).toEqual({ type: 'header', label: 'api (repo)' });
    expect(rows[1]).toMatchObject({ type: 'session', sessionIndex: 0 });
    expect(rows[2]).toMatchObject({ type: 'session', sessionIndex: 1 });
    expect(rows[3]).toEqual({ type: 'header', label: 'frontend (repo)' });
    expect(rows[4]).toMatchObject({ type: 'session', sessionIndex: 2 });
  });

  it('labels groups correctly', () => {
    const sessions = [makeSession('fullstack', 'dev', true)];
    const rows = buildSidebarRows(sessions);

    expect(rows[0]).toEqual({ type: 'header', label: 'fullstack (group)' });
  });

  it('assigns sequential sessionIndex across groups', () => {
    const sessions = [
      makeSession('a', 'b1'),
      makeSession('b', 'b2'),
      makeSession('b', 'b3'),
    ];
    const rows = buildSidebarRows(sessions);
    const indices = rows
      .filter((r) => r.type === 'session')
      .map((r) => (r as any).sessionIndex);
    expect(indices).toEqual([0, 1, 2]);
  });
});
