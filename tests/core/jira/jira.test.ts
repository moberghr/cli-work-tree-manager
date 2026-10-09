import { describe, expect, it, vi } from 'vitest';

// acli, as the Jira tab asks it: the arguments are recorded, the answers made up.
const calls = vi.hoisted(() => [] as string[][]);
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    calls.push(args);
    if (args.includes('auth')) return cb(null, 'Site: example.atlassian.net\n');
    cb(
      null,
      JSON.stringify([
        {
          key: 'OPS-2465',
          fields: { summary: 'EUR merchant', status: { name: 'Waiting for feedback', statusCategory: { key: 'indeterminate' } } },
        },
      ]),
    );
  },
}));

const { fetchMyIssues, fetchMyIssuesOrThrow, MY_ISSUES_JQL, myAccountId } = await import('../../../src/core/jira/jira.js');

describe('your issues (the Jira tab)', () => {
  it("open by the status's category, not by resolution: a service desk sets one on issues still open (OPS-2465, Waiting for feedback)", async () => {
    expect(MY_ISSUES_JQL).not.toMatch(/resolution/i);
    expect(MY_ISSUES_JQL).toContain('statusCategory != Done');
    const issues = await fetchMyIssues();
    expect(calls.find((a) => a.includes('search'))).toContain(MY_ISSUES_JQL);
    expect(issues.map((i) => [i.key, i.status, i.url])).toEqual([
      ['OPS-2465', 'Waiting for feedback', 'https://example.atlassian.net/browse/OPS-2465'],
    ]);
  });

  it('for the Jira watch: all of them (paginated, not the 50 most recently updated)', async () => {
    calls.length = 0;
    expect((await fetchMyIssuesOrThrow()).map((i) => i.key)).toEqual(['OPS-2465']);
    const search = calls.find((a) => a.includes('search'))!;
    expect(search).toContain('--paginate');
    expect(search).not.toContain('--limit');
  });

  it("your account id that can't be told (no assignee in the answer): not asked again for a while", async () => {
    calls.length = 0;
    expect(await myAccountId()).toBeNull(); // the made-up answer has no assignee
    expect(await myAccountId()).toBeNull();
    expect(calls.filter((a) => a.includes('assignee'))).toHaveLength(1);
  });
});
