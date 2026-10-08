import { describe, it, expect } from 'vitest';
import { jiraPrompt, prPick, prPrompt } from '../../src/web/src/state/start-prompts.js';
import type { PrInfo } from '../../src/web/src/api/panes.js';

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 42,
  title: 'Add CSV export',
  branch: 'feat/csv',
  url: 'https://gh/pr/42',
  isDraft: false,
  checksStatus: 'SUCCESS',
  reviewDecision: 'NONE',
  myReview: 'NONE',
  isMine: true,
  repoAlias: 'api',
  ...over,
});

describe('start prompts', () => {
  it('a Jira issue: key, summary and where to read it', () => {
    const p = jiraPrompt({
      key: 'ABC-1',
      summary: 'Export invoices',
      status: 'To Do',
      issuetype: 'Story',
      priority: 'High',
      url: 'https://jira/ABC-1',
    });
    expect(p.split('\n')[0]).toBe('Work on ABC-1: Export invoices');
    expect(p).toContain('https://jira/ABC-1');
  });

  it('a PR: what needs doing — failing checks, requested changes — or catching up', () => {
    expect(prPrompt(pr({ checksStatus: 'FAILURE' }))).toContain('checks are failing');
    const changes = prPrompt(pr({ reviewDecision: 'CHANGES_REQUESTED' }));
    expect(changes).toContain('gh pr view 42 --comments');
    expect(changes).toContain("Don't reply on GitHub");
    expect(prPrompt(pr())).toContain('Get up to speed');
    expect(prPrompt(pr()).split('\n')[0]).toBe('Continue on PR #42: Add CSV export');
  });

  it('a conflict says to bring the base in, not to look at check logs', () => {
    const p = prPrompt(pr({ conflicting: true }));
    expect(p).toContain('conflicts with its base branch');
    expect(p).not.toContain('checks are failing');
  });

  it("someone else's PR is reviewed, never changed or posted to", () => {
    const p = prPrompt(pr({ isMine: false, checksStatus: 'FAILURE', reviewRequested: true }));
    expect(p.split('\n')[0]).toBe('Review PR #42: Add CSV export');
    expect(p).toContain("Don't commit, push or post anything on GitHub.");
    expect(p).not.toContain('fix them');
  });

  it("a fork's PR is reviewed on a branch of its own, its code checked out there (its branch isn't on origin)", () => {
    const fork = pr({ isMine: false, fork: true, branch: 'patch-1', repoAlias: 'web' });
    expect(prPick(fork)).toEqual({ target: 'web', branch: 'review/pr-42', prompt: prPrompt(fork) });
    expect(prPrompt(fork)).toContain('gh pr checkout 42 --detach');
    expect(prPick(pr({ branch: 'feat/csv' })).branch).toBe('feat/csv');
    expect(prPrompt(pr({ isMine: false }))).not.toContain('checkout');
  });
});
