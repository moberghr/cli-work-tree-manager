import { describe, expect, it } from 'vitest';
import { groupRepoNames, groupSessionsByTarget } from '../../src/web/src/utils/session-groups.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

function s(target: string, branch: string, isGroup = false): SessionSummary {
  return {
    id: `${target}:${branch}`,
    target,
    branch,
    isGroup,
    paths: [],
    createdAt: '',
    lastAccessedAt: '',
  };
}

describe('groupSessionsByTarget', () => {
  it('buckets by target, keeping input order inside and across buckets', () => {
    const groups = groupSessionsByTarget([
      s('proj-frontend-ai', 'b1'),
      s('fullstack-ai', 'b2', true),
      s('proj-frontend-ai', 'b3'),
      s('proj-backend-ai', 'b4'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['proj-frontend-ai', 'fullstack-ai', 'proj-backend-ai']);
    expect(groups[0].sessions.map((x) => x.branch)).toEqual(['b1', 'b3']);
    expect(groups[1].isGroup).toBe(true);
    expect(groups[0].isGroup).toBe(false);
  });

  it('orders buckets alphabetically (case-insensitive) when asked', () => {
    const groups = groupSessionsByTarget([s('beta', 'x'), s('Alpha', 'y'), s('gamma', 'z')], true);
    expect(groups.map((g) => g.key)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('collects the union of member repos for a group bucket', () => {
    const [g] = groupSessionsByTarget([
      { ...s('fs', 'a', true), paths: ['/wt/fs/a/api', '/wt/fs/a/web'] },
      { ...s('fs', 'b', true), paths: ['/wt/fs/b/api', '/wt/fs/b/docs'] },
    ]);
    expect(g.repos).toEqual(['api', 'web', 'docs']);
  });

  it('returns no buckets for no sessions', () => {
    expect(groupSessionsByTarget([])).toEqual([]);
  });
});

describe('groupRepoNames', () => {
  it('lists repo folder names for a multi-repo group (either separator)', () => {
    const g = {
      ...s('fullstack-ai', 'feat/x', true),
      paths: ['C:\\wt\\fullstack-ai\\feat-x\\backend', '/wt/fullstack-ai/feat-x/frontend/'],
    };
    expect(groupRepoNames(g)).toEqual(['backend', 'frontend']);
  });

  it('is empty for single repos and one-repo groups', () => {
    expect(groupRepoNames({ ...s('repo', 'b'), paths: ['/a', '/b'] })).toEqual([]);
    expect(groupRepoNames({ ...s('g', 'b', true), paths: ['/wt/g/b/only'] })).toEqual([]);
  });
});
