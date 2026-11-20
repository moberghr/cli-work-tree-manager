import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

/** The PR's pushes as Azure DevOps lists them: the review's commit `abc` is iteration 3. */
const ITERATIONS = {
  value: [
    { id: 1, sourceRefCommit: { commitId: 'old' } },
    { id: 3, sourceRefCommit: { commitId: 'abc' } },
  ],
};
const isIterations = (args: string[]) => args[args.indexOf('--resource') + 1] === 'pullRequestIterations';
/** An Azure recorder: the iterations lookup answered (and not counted), every other call by `answer`. */
function azRecorder(answer: (args: string[]) => { code: number; stdout: string; stderr: string }) {
  const r = recorder((args) => (isIterations(args) ? { code: 0, stdout: JSON.stringify(ITERATIONS), stderr: '' } : answer(args)));
  return {
    run: r.run,
    get calls() {
      return r.calls.filter((c) => !isIterations(c.args));
    },
    all: r.calls,
  };
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

  it('approve: two line threads at the push the review read, a summary thread, then the vote', async () => {
    const rec = azRecorder(() => ({ code: 0, stdout: JSON.stringify({ id: 5 }), stderr: '' }));
    const r = await azure.submitReview(rec.run, repo, 7, { commitId: 'abc', event: 'approve', body: 'Looks good.', comments });
    expect(r).toEqual({ ok: true, url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7' });
    const calls = rec.calls;
    expect(
      calls.map((c) =>
        c.args[0] === 'devops'
          ? `thread ${(c.file as { threadContext?: { filePath: string } }).threadContext?.filePath ?? 'summary'}`
          : c.args.slice(0, 7).join(' '),
      ),
    ).toEqual(['thread /src/a.cs', 'thread /src/b.cs', 'thread summary', 'repos pr set-vote --id 7 --vote approve']);
    // Each thread whole: the comment, its line, and the iteration whose source commit the review read (3, not the latest).
    expect(calls[0].file).toEqual({
      comments: [{ parentCommentId: 0, content: 'Guard with a row version.', commentType: 1 }],
      status: 'active',
      threadContext: { filePath: '/src/a.cs', rightFileStart: { line: 6, offset: 1 }, rightFileEnd: { line: 6, offset: 1 } },
      pullRequestThreadContext: { iterationContext: { firstComparingIteration: 3, secondComparingIteration: 3 } },
    });
    expect(calls[2].file).toEqual({ comments: [{ parentCommentId: 0, content: 'Looks good.', commentType: 1 }], status: 'active' });
    expect(calls[3].args).toEqual([
      'repos',
      'pr',
      'set-vote',
      '--id',
      '7',
      '--vote',
      'approve',
      '--org',
      'https://dev.azure.com/acme',
      '--output',
      'json',
    ]);
  });

  it('a review whose commit is no push of the PR any more posts nothing', async () => {
    const rec = recorder((args) =>
      isIterations(args)
        ? { code: 0, stdout: JSON.stringify({ value: [{ id: 4, sourceRefCommit: { commitId: 'newer' } }] }), stderr: '' }
        : { code: 0, stdout: '{}', stderr: '' },
    );
    expect(await azure.submitReview(rec.run, repo, 7, { commitId: 'abc', event: 'approve', body: 'x', comments })).toEqual({
      ok: false,
      error: 'the PR has no push at abc (it moved since the review was prepared)',
      posted: 0,
    });
    expect(rec.calls).toHaveLength(1);
  });

  it('a plain comment leaves the vote alone; request changes is "wait for author"; a failed thread stops it', async () => {
    const plain = azRecorder(() => ({ code: 0, stdout: '{}', stderr: '' }));
    await azure.submitReview(plain.run, repo, 7, { commitId: 'abc', event: 'comment', body: '', comments: comments.slice(0, 1) });
    expect(plain.calls.some((c) => c.args.includes('set-vote'))).toBe(false);
    const changes = azRecorder(() => ({ code: 0, stdout: '{}', stderr: '' }));
    await azure.submitReview(changes.run, repo, 7, { commitId: 'abc', event: 'request-changes', body: '', comments: [] });
    expect(changes.calls.at(-1)!.args).toEqual(expect.arrayContaining(['set-vote', '--vote', 'wait-for-author']));
    const withComments = azRecorder(() => ({ code: 0, stdout: '{}', stderr: '' }));
    expect(
      await azure.submitReview(withComments.run, repo, 7, { commitId: 'abc', event: 'request-changes', body: 'Two things.', comments }),
    ).toMatchObject({ ok: true });
    expect(withComments.calls.map((c) => (c.args[0] === 'devops' ? 'thread' : c.args[2]))).toEqual([
      'thread',
      'thread',
      'thread',
      'set-vote',
    ]);
    expect(withComments.calls.at(-1)!.args).toEqual(
      expect.arrayContaining(['--vote', 'wait-for-author', '--org', 'https://dev.azure.com/acme']),
    );
    const failing = azRecorder(() => ({ code: 1, stdout: '', stderr: 'TF401181: The pull request cannot be edited' }));
    expect(await azure.submitReview(failing.run, repo, 7, { commitId: 'abc', event: 'approve', body: '', comments })).toEqual({
      ok: false,
      error: 'src/a.cs:6: TF401181: The pull request cannot be edited',
      posted: 0,
    });
  });
});

describe('a submit that stops part way says what went out, and what may have', () => {
  let repo: string;
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'az-partial-'));
    fs.mkdirSync(path.join(repo, '.git'));
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://dev.azure.com/acme/Shop/_git/api\n');
  });
  afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
  const failOn = (n: number, code: number, stderr = 'TF400898: server error') => {
    let calls = 0;
    return azRecorder(() => (++calls === n ? { code, stdout: '', stderr } : { code: 0, stdout: '{}', stderr: '' }));
  };
  const review = { commitId: 'abc', event: 'approve' as const, body: 'Looks good.', comments };

  it('Azure DevOps: the second thread is refused (a clear refusal) — the first went out; nothing is in doubt', async () => {
    expect(await azure.submitReview(failOn(2, 1, 'TF401181: The pull request cannot be edited').run, repo, 7, review)).toEqual({
      ok: false,
      error: 'src/b.cs:2: TF401181: The pull request cannot be edited',
      posted: 1,
    });
  });

  it('Azure DevOps: a server error (no clear refusal) may have gone through: in doubt, with the steps after it untried', async () => {
    expect(await azure.submitReview(failOn(2, 1).run, repo, 7, review)).toEqual({
      ok: false,
      error: 'src/b.cs:2: TF400898: server error',
      posted: 1,
      inDoubt: { comments: [1], summary: false, rest: true },
    });
    // az said it did it in words that couldn't be read: in doubt too.
    let calls = 0;
    const garbled = azRecorder(() => (++calls === 1 ? { code: 0, stdout: 'not json', stderr: '' } : { code: 0, stdout: '{}', stderr: '' }));
    expect(await azure.submitReview(garbled.run, repo, 7, review)).toMatchObject({
      posted: 0,
      inDoubt: { comments: [0], summary: false, rest: true },
    });
    // The last comment of a plain comment review with no summary: nothing after it.
    const plain = { ...review, event: 'comment' as const, body: '' };
    expect(await azure.submitReview(failOn(2, 124, 'az timed out').run, repo, 7, plain)).toMatchObject({
      inDoubt: { comments: [1], summary: false, rest: false },
    });
  });

  it('Azure DevOps: a thread call that timed out may have gone through: it is in doubt, the ones before it posted', async () => {
    expect(await azure.submitReview(failOn(2, 124, 'az timed out').run, repo, 7, review)).toEqual({
      ok: false,
      error: 'src/b.cs:2: az timed out',
      posted: 1,
      inDoubt: { comments: [1], summary: false, rest: true },
    });
  });

  it('Azure DevOps: the summary fails (or times out), then the vote fails — each says what went out', async () => {
    expect(await azure.submitReview(failOn(3, 1, 'ERROR: (400) Bad Request').run, repo, 7, review)).toEqual({
      ok: false,
      error: 'the summary: ERROR: (400) Bad Request',
      posted: 2,
    });
    expect(await azure.submitReview(failOn(3, 124, 'slow').run, repo, 7, review)).toMatchObject({
      posted: 2,
      inDoubt: { comments: [], summary: true, rest: true }, // the vote after it wasn't cast
    });
    expect(await azure.submitReview(failOn(4, 1, 'TF401181: no vote').run, repo, 7, review)).toEqual({
      ok: false,
      error: "the comments went out, the vote didn't: TF401181: no vote",
      posted: 2,
      summaryPosted: true,
    });
  });

  it('GitHub: a 502, a reset connection — no clear refusal — may have made it: all of it in doubt; a 422 is a refusal', async () => {
    for (const stderr of ['gh: Bad Gateway (HTTP 502)', 'read tcp: connection reset by peer', '']) {
      const { run } = azRecorder(() => ({ code: 1, stdout: '', stderr }));
      expect(await github.submitReview(run, '/repo', 7, review)).toMatchObject({ ok: false, inDoubt: { comments: [0, 1], summary: true } });
    }
    for (const stderr of ['gh: Validation Failed (HTTP 422)', 'To get started with GitHub CLI, please run:  gh auth login']) {
      const { run } = azRecorder(() => ({ code: 1, stdout: '', stderr }));
      expect(await github.submitReview(run, '/repo', 7, review)).not.toHaveProperty('inDoubt');
    }
  });

  it('GitHub: the temp file that can’t be removed (in use on Windows) never turns a review that went out into a failure', async () => {
    const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    });
    try {
      const { run } = recorder(() => ({ code: 0, stdout: JSON.stringify({ html_url: 'u' }), stderr: '' }));
      expect(await github.submitReview(run, '/repo', 7, review)).toEqual({ ok: true, url: 'u' });
    } finally {
      rm.mockRestore();
    }
  });

  it('GitHub: one call makes all of it or none; one that timed out may have made it — all of it is in doubt', async () => {
    const { run } = azRecorder(() => ({ code: 124, stdout: '', stderr: 'gh timed out' }));
    expect(await github.submitReview(run, '/repo', 7, review)).toEqual({
      ok: false,
      error: 'gh timed out',
      inDoubt: { comments: [0, 1], summary: true },
    });
  });
});

describe('open PRs for the review queue: a list at its limit says there may be more', () => {
  it('GitHub', async () => {
    const row = (n: number) => ({ number: n, headRefOid: `s${n}` });
    const full = recorder(() => ({ code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => row(i + 1))), stderr: '' }));
    const r = await github.openPrs(full.run, '/repo');
    expect(r.ok && r.prs.length).toBe(100);
    expect(r.ok && r.more).toBe(true);
    expect(full.calls[0].args).toEqual(expect.arrayContaining(['--limit', '100']));
    const some = await github.openPrs(recorder(() => ({ code: 0, stdout: JSON.stringify([row(1)]), stderr: '' })).run, '/repo');
    expect(some.ok && some.more).toBeUndefined();
  });

  it('Azure DevOps — and an answer that isn\'t a list is a failure, never "no PRs" (that would drop every review)', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'az-open-'));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://dev.azure.com/acme/Shop/_git/api\n');
      const pr = (n: number) => ({ pullRequestId: n, status: 'active', lastMergeSourceCommit: { commitId: `s${n}` } });
      const full = recorder(() => ({ code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => pr(i + 1))), stderr: '' }));
      const r = await azure.openPrs(full.run, repo);
      expect(r.ok && r.more).toBe(true);
      expect(await azure.openPrs(recorder(() => ({ code: 0, stdout: '{"value": []}', stderr: '' })).run, repo)).toEqual({
        ok: false,
        error: "couldn't read what az said",
      });
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
