import { afterEach, describe, expect, it, vi } from 'vitest';

// acli, as the Time tab asks it: the JQL recorded, the answers made up.
const jql = vi.hoisted(() => [] as string[]);
const limits = vi.hoisted(() => [] as Array<number | undefined>);
const account = vi.hoisted(() => ({ id: 'acc-1' as string | null, updatedByFails: false }));
vi.mock('../../../src/core/jira/jira.js', () => ({
  searchIssuesOrThrow: async (q: string, limit?: number) => {
    jql.push(q);
    limits.push(limit);
    if (q.startsWith('status CHANGED')) return [{ key: 'APP-1', summary: 'Moved', status: 'Review' }];
    if (account.updatedByFails) throw new Error('not supported');
    return [
      { key: 'APP-1', summary: 'Moved', status: 'Review' },
      { key: 'OPS-2486', summary: 'Commented on', status: 'Waiting for feedback' },
    ];
  },
  myAccountId: async () => account.id,
  fetchMyIssues: async () => [],
  issueIdOf: async () => null,
}));

const { jiraOn, defaultTimeDeps } = await import('../../../src/core/time/time-deps.js');

afterEach(() => {
  jql.length = 0;
  account.id = 'acc-1';
  account.updatedByFails = false;
  delete process.env.JIRA_ACCOUNT_ID;
});

describe('what you did in Jira that day (time-deps.ts)', () => {
  it('status moves, and anything else you updated (a comment, an edit) by your account id; each issue once', async () => {
    expect(await jiraOn('2026-10-07')).toEqual([
      { key: 'APP-1', summary: 'Moved', what: 'moved (now Review)' },
      { key: 'OPS-2486', summary: 'Commented on', what: 'updated by you (a comment or an edit)' },
    ]);
    // acli refuses currentUser() inside updatedBy(): the account id, and the day's own bounds (not the next day's date).
    expect(jql[0]).toBe('status CHANGED BY currentUser() DURING ("2026/10/07 00:00", "2026/10/08 00:00")');
    // To the next day's start: a change at 23:59:30 is on the day.
    expect(jql[1]).toBe('issuekey IN updatedBy("acc-1", "2026/10/07 00:00", "2026/10/08 00:00")');
    // Not acli's 50: a sprint's close or a triage moves more in a day.
    expect(limits.slice(0, 2)).toEqual([500, 500]);
  });

  it('the account id from JIRA_ACCOUNT_ID first; none known: the moves alone; updatedBy refused: a failure (the day keeps what it had)', async () => {
    process.env.JIRA_ACCOUNT_ID = 'env-acc';
    await jiraOn('2026-10-07');
    expect(jql[1]).toContain('updatedBy("env-acc"');
    delete process.env.JIRA_ACCOUNT_ID;
    account.id = null;
    expect((await jiraOn('2026-10-07')).map((j) => j.key)).toEqual(['APP-1']);
    account.id = 'acc-1';
    account.updatedByFails = true;
    await expect(jiraOn('2026-10-07')).rejects.toThrow('not supported');
  });

  it("a day's Jira is read once until the next full run: a turn's run doesn't ask acli again", async () => {
    const deps = defaultTimeDeps();
    await deps.jiraMoved('2026-10-07');
    const asked = jql.length;
    deps.fresh?.('local');
    await deps.jiraMoved('2026-10-07');
    expect(jql.length).toBe(asked);
    deps.fresh?.('all');
    await deps.jiraMoved('2026-10-07');
    expect(jql.length).toBeGreaterThan(asked);
  });
});
