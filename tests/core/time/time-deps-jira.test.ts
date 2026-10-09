import { afterEach, describe, expect, it, vi } from 'vitest';

// acli, as the Time tab asks it: the JQL recorded, the answers made up.
const jql = vi.hoisted(() => [] as string[]);
const account = vi.hoisted(() => ({ id: 'acc-1' as string | null, updatedByFails: false }));
vi.mock('../../../src/core/jira/jira.js', () => ({
  searchIssuesOrThrow: async (q: string) => {
    jql.push(q);
    if (q.startsWith('status CHANGED')) return [{ key: 'SD-1', summary: 'Moved', status: 'Review' }];
    if (account.updatedByFails) throw new Error('not supported');
    return [
      { key: 'SD-1', summary: 'Moved', status: 'Review' },
      { key: 'SSD-2486', summary: 'Commented on', status: 'Waiting for feedback' },
    ];
  },
  myAccountId: async () => account.id,
  fetchMyIssues: async () => [],
  issueIdOf: async () => null,
}));

const { jiraOn } = await import('../../../src/core/time/time-deps.js');

afterEach(() => {
  jql.length = 0;
  account.id = 'acc-1';
  account.updatedByFails = false;
  delete process.env.JIRA_ACCOUNT_ID;
});

describe('what you did in Jira that day (time-deps.ts)', () => {
  it('status moves, and anything else you updated (a comment, an edit) by your account id; each issue once', async () => {
    expect(await jiraOn('2026-10-07')).toEqual([
      { key: 'SD-1', summary: 'Moved', what: 'moved (now Review)' },
      { key: 'SSD-2486', summary: 'Commented on', what: 'updated by you (a comment or an edit)' },
    ]);
    // acli refuses currentUser() inside updatedBy(): the account id, the day to the next.
    expect(jql[1]).toBe('issuekey IN updatedBy("acc-1", "2026/10/07", "2026/10/08")');
  });

  it('the account id from JIRA_ACCOUNT_ID first; none known, or updatedBy refused: the moves alone', async () => {
    process.env.JIRA_ACCOUNT_ID = 'env-acc';
    await jiraOn('2026-10-07');
    expect(jql[1]).toContain('updatedBy("env-acc"');
    delete process.env.JIRA_ACCOUNT_ID;
    account.id = null;
    expect((await jiraOn('2026-10-07')).map((j) => j.key)).toEqual(['SD-1']);
    account.id = 'acc-1';
    account.updatedByFails = true;
    expect((await jiraOn('2026-10-07')).map((j) => j.key)).toEqual(['SD-1']);
  });
});
