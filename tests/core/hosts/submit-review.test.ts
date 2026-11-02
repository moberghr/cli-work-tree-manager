import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { github } from '../../../src/core/hosts/github/adapter.js';
import { azure } from '../../../src/core/hosts/azure/adapter.js';
import type { CommandRunner } from '../../../src/core/platform/command-runner.js';

/** A review submitted in one go, on each host: what reaches its CLI (argv only; bodies through a temp file). */

const comments = [
  { path: 'src/a.cs', line: 6, body: 'Guard with a row version.' },
  { path: 'src/b.cs', line: 2, body: "Don't round here." },
];

function recorder(answer: (args: string[]) => { code: number; stdout: string; stderr: string }) {
  const calls: Array<{ cmd: string; args: string[]; file?: unknown }> = [];
  const run: CommandRunner = async (cmd, args) => {
    const i = args.findIndex((a) => a === '--input' || a === '--in-file');
    calls.push({ cmd, args, ...(i >= 0 ? { file: JSON.parse(fs.readFileSync(args[i + 1], 'utf8')) } : {}) });
    return answer(args);
  };
  return { run, calls };
}

describe('GitHub: one review with its line comments', () => {
  it('posts the verdict, summary and comments at the head commit, and answers its link; the temp file goes', async () => {
    const { run, calls } = recorder(() => ({
      code: 0,
      stdout: JSON.stringify({ html_url: 'https://github.com/a/b/pull/7#pullrequestreview-1' }),
      stderr: '',
    }));
    const r = await github.submitReview(run, '/repo', 7, { commitId: 'abc', event: 'request-changes', body: 'Two things.', comments });
    expect(r).toEqual({ ok: true, url: 'https://github.com/a/b/pull/7#pullrequestreview-1' });
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args.slice(0, 4)).toEqual(['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews']);
    expect(calls[0].file).toEqual({
      commit_id: 'abc',
      event: 'REQUEST_CHANGES',
      body: 'Two things.',
      comments: comments.map((c) => ({ ...c, side: 'RIGHT' })),
    });
    expect(fs.existsSync(calls[0].args[calls[0].args.indexOf('--input') + 1])).toBe(false);
  });

  it("gh's refusal comes back with its reason", async () => {
    const { run } = recorder(() => ({ code: 1, stdout: '', stderr: 'Unprocessable Entity: line must be part of the diff\nmore' }));
    expect(await github.submitReview(run, '/repo', 7, { commitId: 'abc', event: 'comment', body: '', comments })).toEqual({
      ok: false,
      error: 'Unprocessable Entity: line must be part of the diff',
    });
  });
});

describe('Azure DevOps: each comment a thread, the summary a thread, the verdict a vote', () => {
  let repo: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'az-submit-'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://dev.azure.com/acme/Shop/_git/api\n');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('approve: two line threads, a summary thread, then the vote', async () => {
    const { run, calls } = recorder(() => ({ code: 0, stdout: JSON.stringify({ id: 5 }), stderr: '' }));
    const r = await azure.submitReview(run, repo, 7, { commitId: 'abc', event: 'approve', body: 'Looks good.', comments });
    expect(r).toEqual({ ok: true, url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7' });
    expect(
      calls.map((c) =>
        c.args[0] === 'devops'
          ? `thread ${(c.file as { threadContext?: { filePath: string } }).threadContext?.filePath ?? 'summary'}`
          : c.args.slice(0, 7).join(' '),
      ),
    ).toEqual(['thread /src/a.cs', 'thread /src/b.cs', 'thread summary', 'repos pr set-vote --id 7 --vote approve']);
  });

  it('a plain comment leaves the vote alone; request changes is "wait for author"; a failed thread stops it', async () => {
    const plain = recorder(() => ({ code: 0, stdout: '{}', stderr: '' }));
    await azure.submitReview(plain.run, repo, 7, { commitId: 'abc', event: 'comment', body: '', comments: comments.slice(0, 1) });
    expect(plain.calls.some((c) => c.args.includes('set-vote'))).toBe(false);
    const changes = recorder(() => ({ code: 0, stdout: '{}', stderr: '' }));
    await azure.submitReview(changes.run, repo, 7, { commitId: 'abc', event: 'request-changes', body: '', comments: [] });
    expect(changes.calls.at(-1)!.args).toEqual(expect.arrayContaining(['set-vote', '--vote', 'wait-for-author']));
    const failing = recorder(() => ({ code: 1, stdout: '', stderr: 'TF401181: The pull request cannot be edited' }));
    expect(await azure.submitReview(failing.run, repo, 7, { commitId: 'abc', event: 'approve', body: '', comments })).toEqual({
      ok: false,
      error: 'src/a.cs:6: TF401181: The pull request cannot be edited',
    });
  });
});
