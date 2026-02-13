import { describe, it, expect } from 'vitest';
import { resolveProjectTarget, getAllTargetNames } from '../../src/core/resolve.js';
import type { WorkConfig } from '../../src/core/config.js';

const config: WorkConfig = {
  worktreesRoot: '/tmp/worktrees',
  repos: {
    api: '/repos/api',
    frontend: '/repos/frontend',
    shared: '/repos/shared',
  },
  groups: {
    fullstack: ['api', 'frontend'],
    all: ['api', 'frontend', 'shared'],
  },
  copyFiles: [],
};

describe('resolveProjectTarget', () => {
  it('resolves a single repo', () => {
    const result = resolveProjectTarget('api', config);
    expect(result).toEqual({
      isGroup: false,
      name: 'api',
      repoAliases: ['api'],
    });
  });

  it('resolves a group', () => {
    const result = resolveProjectTarget('fullstack', config);
    expect(result).toEqual({
      isGroup: true,
      name: 'fullstack',
      repoAliases: ['api', 'frontend'],
    });
  });

  it('returns null for unknown name', () => {
    const result = resolveProjectTarget('nonexistent', config);
    expect(result).toBeNull();
  });

  it('prefers group over repo if names collide', () => {
    const collisionConfig: WorkConfig = {
      ...config,
      repos: { ...config.repos, fullstack: '/repos/fullstack' },
    };
    const result = resolveProjectTarget('fullstack', collisionConfig);
    expect(result?.isGroup).toBe(true);
  });

  it('returns a copy of repoAliases (not a reference)', () => {
    const result = resolveProjectTarget('fullstack', config);
    result!.repoAliases.push('extra');
    expect(config.groups.fullstack).toEqual(['api', 'frontend']);
  });
});

describe('getAllTargetNames', () => {
  it('returns all repo and group names', () => {
    const names = getAllTargetNames(config);
    expect(names).toEqual(['api', 'frontend', 'shared', 'fullstack', 'all']);
  });

  it('returns empty array when no repos or groups', () => {
    const empty: WorkConfig = {
      worktreesRoot: '',
      repos: {},
      groups: {},
      copyFiles: [],
    };
    expect(getAllTargetNames(empty)).toEqual([]);
  });
});
