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
          key: 'SSD-2465',
          fields: { summary: 'EUR merchant', status: { name: 'Waiting for feedback', statusCategory: { key: 'indeterminate' } } },
        },
      ]),
    );
  },
}));

const { fetchMyIssues, MY_ISSUES_JQL } = await import('../../../src/core/jira/jira.js');

describe('your issues (the Jira tab)', () => {
  it("open by the status's category, not by resolution: a service desk sets one on issues still open (SSD-2465, Waiting for feedback)", async () => {
    expect(MY_ISSUES_JQL).not.toMatch(/resolution/i);
    expect(MY_ISSUES_JQL).toContain('statusCategory != Done');
    const issues = await fetchMyIssues();
    expect(calls.find((a) => a.includes('search'))).toContain(MY_ISSUES_JQL);
    expect(issues.map((i) => [i.key, i.status, i.url])).toEqual([
      ['SSD-2465', 'Waiting for feedback', 'https://example.atlassian.net/browse/SSD-2465'],
    ]);
  });
});
