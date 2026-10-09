import { describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { otherBranchText } from '../../src/web/src/components/Dashboard/SessionBits.js';

const s = (over: Partial<SessionSummary>): SessionSummary =>
  ({ id: 'x', target: 'api', branch: 'tmp/keys', isGroup: false, paths: [], createdAt: '', lastAccessedAt: '', ...over }) as SessionSummary;

describe('otherBranchText', () => {
  it('nothing when the worktree is on its own branch', () => {
    expect(otherBranchText(s({}))).toBeNull();
    expect(otherBranchText(s({ onOtherBranch: [] }))).toBeNull();
  });

  it('a repo: the branch; a group: each repo that moved; a detached HEAD said as such', () => {
    expect(otherBranchText(s({ onOtherBranch: [{ repo: 'api', branch: 'fix/nexo' }] }))).toBe('on fix/nexo');
    expect(
      otherBranchText(
        s({
          isGroup: true,
          onOtherBranch: [
            { repo: 'frontend', branch: 'task/APP-1' },
            { repo: 'backend', branch: null },
          ],
        }),
      ),
    ).toBe('frontend on task/APP-1, backend on a detached HEAD');
  });

  it('a folder with no git left in it: not a git checkout, not "a detached HEAD"', () => {
    expect(otherBranchText(s({ onOtherBranch: [{ repo: 'api', branch: null, noGit: true }] }))).toBe('not a git checkout any more');
    expect(otherBranchText(s({ isGroup: true, onOtherBranch: [{ repo: 'backend', branch: null, noGit: true }] }))).toBe(
      'backend not a git checkout any more',
    );
  });
});
