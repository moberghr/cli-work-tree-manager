import { describe, it, expect } from 'vitest';
import { buildSessionRows, buildProjectRows } from '../../src/tui-ink/Sidebar.js';
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

describe('buildSessionRows', () => {
  it('returns empty array for empty sessions', () => {
    expect(buildSessionRows([])).toEqual([]);
  });

  it('groups sessions by target with headers', () => {
    const sessions = [
      makeSession('api', 'feature-a'),
      makeSession('api', 'feature-b'),
      makeSession('frontend', 'main'),
    ];
    const rows = buildSessionRows(sessions);

    expect(rows).toHaveLength(5); // 2 headers + 3 sessions
    expect(rows[0]).toEqual({ type: 'header', label: 'api (repo)' });
    expect(rows[1]).toMatchObject({ type: 'session', sessionIndex: 0 });
    expect(rows[2]).toMatchObject({ type: 'session', sessionIndex: 1 });
    expect(rows[3]).toEqual({ type: 'header', label: 'frontend (repo)' });
    expect(rows[4]).toMatchObject({ type: 'session', sessionIndex: 2 });
  });

  it('labels groups correctly', () => {
    const sessions = [makeSession('fullstack', 'dev', true)];
    const rows = buildSessionRows(sessions);

    expect(rows[0]).toEqual({ type: 'header', label: 'fullstack (group)' });
  });

  it('assigns sequential sessionIndex across groups', () => {
    const sessions = [
      makeSession('a', 'b1'),
      makeSession('b', 'b2'),
      makeSession('b', 'b3'),
    ];
    const rows = buildSessionRows(sessions);
    const indices = rows
      .filter((r) => r.type === 'session')
      .map((r) => (r as any).sessionIndex);
    expect(indices).toEqual([0, 1, 2]);
  });
});

describe('buildProjectRows', () => {
  it('returns empty array for empty projects', () => {
    expect(buildProjectRows([])).toEqual([]);
  });

  it('includes header and project entries', () => {
    const projects = [
      { name: 'api', isGroup: false },
      { name: 'fullstack', isGroup: true },
    ];
    const rows = buildProjectRows(projects);

    expect(rows).toHaveLength(3); // 1 header + 2 projects
    expect(rows[0]).toEqual({ type: 'header', label: 'Select project' });
    expect(rows[1]).toMatchObject({ type: 'project', name: 'api', isGroup: false });
    expect(rows[2]).toMatchObject({ type: 'project', name: 'fullstack', isGroup: true });
  });
});
