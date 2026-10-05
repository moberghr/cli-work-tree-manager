import { describe, expect, it } from 'vitest';
import { checkBranch, type BranchCheckDeps } from '../../../src/core/worktree/branch-check.js';
import { firstFreeBranch } from '../../../src/core/worktree/branch-name.js';
import type { WorkConfig } from '../../../src/core/platform/config.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';

const config = {
  worktreesRoot: '/wt',
  repos: { api: '/r/api', web: '/r/web' },
  groups: { shop: ['api', 'web'] },
  copyFiles: [],
} as unknown as WorkConfig;

const session = (target: string, branch: string, archivedAt?: string): WorktreeSession =>
  ({
    target,
    branch,
    isGroup: target === 'shop',
    paths: [],
    createdAt: '',
    lastAccessedAt: '',
    ...(archivedAt ? { archivedAt } : {}),
  }) as WorktreeSession;

/** Branches by repo path, and the sessions there are. */
function deps(branches: Record<string, string[]>, sessions: WorktreeSession[] = []): BranchCheckDeps {
  return {
    branchExists: (repo, b) => (branches[repo] ?? []).includes(b),
    validBranch: (b) => !b.startsWith('-') && !b.endsWith('/') && !b.includes(' '),
    sessions: () => sessions,
  };
}

describe('checkBranch: is the branch new for the project?', () => {
  it('a new name is free as it is', () => {
    expect(checkBranch('api', 'fix/tests', config, deps({}))).toEqual({
      branch: 'fix/tests',
      valid: true,
      exists: false,
      session: null,
      free: 'fix/tests',
    });
  });

  it('a branch that exists (local or on origin) is taken: the next free name is offered', () => {
    const r = checkBranch('api', 'fix/tests', config, deps({ '/r/api': ['fix/tests', 'fix/tests-2'] }));
    expect(r).toMatchObject({ exists: true, session: null, free: 'fix/tests-3' });
  });

  it('a session of that name, archived or not, is taken too, and named', () => {
    const old = session('api', 'fix/tests', '2026-09-01T00:00:00Z');
    const r = checkBranch('api', 'fix/tests', config, deps({}, [old]));
    expect(r).toMatchObject({ exists: false, session: { id: sessionIdFor(old), archived: true }, free: 'fix/tests-2' });
    // Another project's session of that name is no clash.
    expect(checkBranch('web', 'fix/tests', config, deps({}, [old])).free).toBe('fix/tests');
  });

  it('a group: the branch in any of its repos counts', () => {
    expect(checkBranch('shop', 'feat/x', config, deps({ '/r/web': ['feat/x'] }))).toMatchObject({ exists: true, free: 'feat/x-2' });
  });

  it('a name git refuses is not valid, and has no free form', () => {
    expect(checkBranch('api', 'fix/', config, deps({}))).toMatchObject({ valid: false, free: null });
  });
});

describe('firstFreeBranch', () => {
  it('stops at -9', () => {
    expect(firstFreeBranch('b', () => true)).toBeNull();
    expect(firstFreeBranch('b', (n) => n !== 'b-9')).toBe('b-9');
  });
});
