import { describe, expect, it } from 'vitest';
import { ownsBranch, projectList } from '../../../src/core/worktree/own-checkout.js';

/** Naming the branch a repo's own folder is on means that folder (it can't be checked out a second time). */
describe('ownsBranch', () => {
  const config = { repos: { api: '/repos/api', web: '/repos/web' }, groups: { shop: ['api', 'web'] } };
  const on = (branches: Record<string, string | null>) => (checkout: string) => branches[checkout] ?? null;

  it('the branch the repo’s own folder is on: yes; any other, or a detached folder: no', () => {
    const read = on({ '/repos/api': 'main', '/repos/web': null });
    expect(ownsBranch('api', 'main', config, read)).toBe(true);
    expect(ownsBranch('api', 'feat/x', config, read)).toBe(false);
    expect(ownsBranch('web', 'main', config, read)).toBe(false);
    expect(ownsBranch('api', '', config, read)).toBe(false);
  });

  it('never a group (it has no one checkout), nor a project that isn’t configured', () => {
    const read = on({ '/repos/api': 'main', '/repos/web': 'main' });
    expect(ownsBranch('shop', 'main', config, read)).toBe(false);
    expect(ownsBranch('docs', 'main', config, read)).toBe(false);
    // A group and a repo of one name: the group's rules.
    expect(ownsBranch('api', 'main', { repos: config.repos, groups: { api: ['web'] } }, read)).toBe(false);
  });
});

describe('projectList (what the New worktree dialog lists)', () => {
  it('each repo with the branch its own folder is on now (null when detached), and the groups with their members', () => {
    const config = { repos: { api: '/repos/api', web: '/repos/web' }, groups: { shop: ['api', 'web'] } };
    const read = (p: string) => (p === '/repos/api' ? 'feat/left-here' : null);
    expect(projectList(config, read)).toEqual({
      singles: [
        { name: 'api', kind: 'single', path: '/repos/api', ownBranch: 'feat/left-here' },
        { name: 'web', kind: 'single', path: '/repos/web', ownBranch: null },
      ],
      groups: [{ name: 'shop', kind: 'group', members: ['api', 'web'] }],
    });
    expect(projectList({ repos: {} }, read)).toEqual({ singles: [], groups: [] });
  });
});
