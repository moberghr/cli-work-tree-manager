import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { github } from '../../../src/core/hosts/github/adapter.js';
import { fetchAllPullRequests } from '../../../src/core/pr/pr.js';
import type { CommandRunner, RunResult } from '../../../src/core/platform/command-runner.js';
import { registerHost } from '../../../src/core/hosts/index.js';
import type { GitHost } from '../../../src/core/hosts/types.js';
import { githubReviewFeedback, githubViewer } from '../../../src/core/hosts/github/review.js';
import { clearGithubServers, FAILED_LOOKUP_MS, githubServerArgs } from '../../../src/core/hosts/github/server.js';
import { githubThreadReply, githubThreadResolve } from '../../../src/core/hosts/github/threads.js';
import { viewerLogin } from '../../../src/core/pr/pr-watch-hosts.js';

/**
 * GitHub's adapter on the paths real users take (#63 review F009, F010):
 * the dashboard's PR list through the host routing, the review queue's open
 * PRs, a line comment posted in your name, and where a PR's code is. gh is a
 * recording runner: what reaches it is argv only.
 */

function recorder(answer: (cmd: string, args: string[]) => Partial<RunResult>) {
  const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
  const run: CommandRunner = async (cmd, args, cwd) => {
    calls.push({ cmd, args, cwd });
    return { code: 0, stdout: '', stderr: '', ...answer(cmd, args) };
  };
  return { run, calls };
}

describe('the PR list through the host routing (the path every dashboard takes)', () => {
  let tmp: string;
  const repo = (name: string, origin: string) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
    return dir;
  };
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-adapter-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const node = {
    number: 12,
    title: 'Fix it',
    url: 'https://github.com/acme/api/pull/12',
    isDraft: false,
    headRefName: 'fix/it',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    isCrossRepository: false,
    author: { login: 'me' },
    repository: { nameWithOwner: 'acme/api' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    reviewRequests: { nodes: [] },
    latestReviews: { nodes: [] },
  };
  const search = JSON.stringify({
    data: { viewer: { login: 'me' }, mine: { issueCount: 1, nodes: [node] }, asked: { issueCount: 0, nodes: [] } },
  });

  it("one search through the runner it's given; GitHub rows carry no `host` (the wire as before hosts)", async () => {
    const api = repo('api', 'git@github.com:acme/api.git');
    const { run, calls } = recorder((cmd, args) => (cmd === 'gh' && args[1] === 'graphql' ? { stdout: search } : { code: 1 }));
    const { map, incomplete } = await fetchAllPullRequests({ api }, { run });
    expect(incomplete).toEqual([]);
    const [pr] = map.get('fix/it') ?? [];
    expect(pr).toMatchObject({ repoAlias: 'api', number: 12, isMine: true, checksStatus: 'SUCCESS' });
    expect('host' in pr).toBe(false);
    expect(calls.map((c) => [c.cmd, c.args.slice(0, 2)])).toEqual([['gh', ['api', 'graphql']]]);
  });

  it('a repo not on github.com (and nobody claims it) is listed by gh pr list in its own folder', async () => {
    const ghe = repo('ghe', 'https://ghe.example.com/acme/ghe.git');
    clearGithubServers();
    const { run, calls } = recorder((cmd, args) =>
      args[0] === 'pr'
        ? { stdout: JSON.stringify([{ number: 3, headRefName: 'b3', author: { login: 'me' } }]) }
        : args[0] === 'repo'
          ? { stdout: 'https://ghe.example.com/acme/ghe\n' }
          : { stdout: 'me\n' },
    );
    const { map } = await fetchAllPullRequests({ ghe }, { run });
    expect(map.get('b3')?.[0]).toMatchObject({ repoAlias: 'ghe', number: 3, isMine: true });
    // "Mine" is your login on that server, not github.com's.
    expect(calls.find((c) => c.args.includes('user'))?.args).toEqual(['api', 'user', '--jq', '.login', '--hostname', 'ghe.example.com']);
    expect('host' in map.get('b3')![0]).toBe(false);
    const list = calls.find((c) => c.args[0] === 'pr')!;
    expect([list.cmd, list.cwd]).toEqual(['gh', ghe]);
    expect(list.args.slice(0, 4)).toEqual(['pr', 'list', '--state', 'open']);
  });

  it("a host whose list throws: its repos are incomplete, another host's PRs still come", async () => {
    const api = repo('api2', 'https://github.com/acme/api.git');
    const brokenRepo = repo('broken', 'https://broken.example/acme/x.git');
    const broken: GitHost = {
      ...github,
      id: 'broken',
      name: 'Broken',
      matches: (o) => o.includes('broken.example'),
      list: async () => {
        throw new Error('boom');
      },
    };
    const drop = registerHost(broken);
    try {
      const { run } = recorder((cmd, args) => (args[1] === 'graphql' ? { stdout: search } : { code: 1 }));
      const { map, incomplete } = await fetchAllPullRequests({ api: api, x: brokenRepo }, { run });
      expect(incomplete).toEqual(['x']);
      expect(map.get('fix/it')?.map((p) => p.repoAlias)).toEqual(['api']);
    } finally {
      drop();
    }
  });
});

describe("GitHub's review-queue groundwork", () => {
  it("openPrs: gh pr list with argv only, its JSON read defensively (an app's login without `app/`, junk rows dropped)", async () => {
    const { run, calls } = recorder(() => ({
      stdout: JSON.stringify([
        {
          number: 7,
          title: 'Add refunds',
          url: 'https://github.com/acme/api/pull/7',
          headRefName: 'feat/refunds',
          headRefOid: 'abc',
          baseRefName: 'main',
          author: { login: 'app/dependabot' },
          isDraft: true,
          additions: 10,
          deletions: 2,
          reviewRequests: [{ login: 'me' }, { name: 'team' }],
        },
        // A fork's: said, so Fix it myself refuses it (its branch isn't on origin).
        { number: 8, headRefOid: 'def', isCrossRepository: true },
        { number: 'x' },
        null,
      ]),
    }));
    const r = await github.openPrs(run, '/repo');
    expect(r).toEqual({
      ok: true,
      prs: [
        {
          number: 7,
          title: 'Add refunds',
          url: 'https://github.com/acme/api/pull/7',
          branch: 'feat/refunds',
          headSha: 'abc',
          base: 'main',
          author: 'dependabot',
          isDraft: true,
          additions: 10,
          deletions: 2,
          requested: ['me'],
        },
        expect.objectContaining({ number: 8, fork: true }),
      ],
    });
    expect((r.ok && r.prs[0]) || {}).not.toHaveProperty('fork');
    expect(calls[0]).toMatchObject({ cmd: 'gh', cwd: '/repo' });
    expect(calls[0].args.slice(0, 4)).toEqual(['pr', 'list', '--state', 'open']);
  });

  it("openPrs: gh missing, gh failing, gh's output unreadable — each says why", async () => {
    expect(await github.openPrs(recorder(() => ({ code: 127 })).run, '/repo')).toEqual({ ok: false, error: 'GitHub CLI (gh) not found' });
    expect(await github.openPrs(recorder(() => ({ code: 1, stderr: 'HTTP 401\nmore' })).run, '/repo')).toEqual({
      ok: false,
      error: 'HTTP 401',
    });
    expect((await github.openPrs(recorder(() => ({ stdout: 'nope' })).run, '/repo')).ok).toBe(false);
  });

  it("prRef: a PR's head, fetchable from origin without a checkout", () => {
    expect(github.prRef(42)).toBe('refs/pull/42/head');
  });
});

describe("a branch's PR, when gh can't say (#63 re-review N005)", () => {
  it('the API-limit line is the reason, wherever gh printed it (the watch rests on it); else the first line', async () => {
    const limited = recorder(() => ({ code: 1, stderr: 'warning: something first\nGraphQL: API rate limit exceeded for user\n' }));
    expect(await github.prForBranch(limited.run, '/repo', 'feat/x')).toEqual({
      kind: 'error',
      error: 'GraphQL: API rate limit exceeded for user',
    });
    const other = recorder(() => ({ code: 1, stderr: 'HTTP 502\nmore' }));
    expect(await github.prForBranch(other.run, '/repo', 'feat/x')).toEqual({ kind: 'error', error: 'HTTP 502' });
    const none = recorder(() => ({ code: 1, stderr: 'no pull requests found for branch "feat/x"' }));
    expect(await github.prForBranch(none.run, '/repo', 'feat/x')).toEqual({ kind: 'none' });
  });
});

describe('which GitHub server a repo is on, asked of gh, for every gh api call (#63 final review H1/H2)', () => {
  let tmp: string;
  const repo = (name: string, origin: string) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${origin}\n`);
    return dir;
  };
  /** gh answering `repo view` with the URL a repo's remote resolves to (`urls` by cwd; none: it can't), `ana` to `api user`. */
  const ghWith = (urls: Record<string, string | null>) => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const run: CommandRunner = async (cmd, args, cwd) => {
      calls.push({ cmd, args, cwd });
      if (args[0] === 'repo') {
        const url = urls[cwd];
        return url
          ? { code: 0, stdout: `${url}\n`, stderr: '' }
          : { code: 1, stdout: '', stderr: 'none of the git remotes point to a known GitHub host' };
      }
      if (args.includes('user')) return { code: 0, stdout: 'ana\n', stderr: '' };
      return { code: 0, stdout: '{"html_url":"https://x/1"}', stderr: '' };
    };
    return { run, calls };
  };
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-server-'));
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => clearGithubServers());

  it('an origin that names github.com is never asked: no --hostname', async () => {
    const a = repo('plain', 'git@github.com:acme/api.git');
    const b = repo('ssh443', 'ssh://git@ssh.github.com:443/acme/api.git');
    const { run, calls } = ghWith({});
    expect(await githubServerArgs(run, a)).toEqual({ ok: true, args: [] });
    expect(await githubServerArgs(run, b)).toEqual({ ok: true, args: [] });
    expect(calls).toEqual([]);
  });

  it("a dotted SSH alias of github.com (git@github.com-work:) is github.com: gh resolves it, so no --hostname (0c9389c's regression)", async () => {
    const dir = repo('alias', 'git@github.com-work:acme/api.git');
    const { run, calls } = ghWith({ [dir]: 'https://github.com/acme/api' });
    expect(await githubServerArgs(run, dir)).toEqual({ ok: true, args: [] });
    expect(await githubViewer(run, dir)).toBe('ana');
    expect(calls.map((c) => c.args)).toEqual([
      ['repo', 'view', '--json', 'url', '--jq', '.url'],
      ['api', 'user', '--jq', '.login'],
    ]);
  });

  it('a dotless GitHub Enterprise host is asked as itself; the answer is cached per repo', async () => {
    const dir = repo('ghe', 'git@ghe:acme/api.git');
    const { run, calls } = ghWith({ [dir]: 'https://ghe/acme/api' });
    expect(await githubServerArgs(run, dir)).toEqual({ ok: true, args: ['--hostname', 'ghe'] });
    expect(await githubViewer(run, dir)).toBe('ana');
    expect(calls.map((c) => c.args)).toEqual([
      ['repo', 'view', '--json', 'url', '--jq', '.url'],
      ['api', 'user', '--jq', '.login', '--hostname', 'ghe'],
    ]);
  });

  it('a lookup that fails holds for a while (no gh api asked meanwhile), then is asked again', async () => {
    const dir = repo('unknown', 'https://git.corp.example/acme/api.git');
    let t = 1_000;
    const now = () => t;
    const { run, calls } = ghWith({});
    const first = await githubServerArgs(run, dir, { now });
    expect(first.ok).toBe(false);
    expect(first.ok ? '' : first.error).toMatch(/couldn't tell which GitHub server git\.corp\.example is \(none of the git remotes/);
    expect(await githubViewer(run, dir, { now })).toBeNull(); // nothing asked of github.com in its place
    t += FAILED_LOOKUP_MS - 1;
    await githubServerArgs(run, dir, { now });
    expect(calls.filter((c) => c.args[0] === 'repo')).toHaveLength(1);
    expect(calls.filter((c) => c.args[0] === 'api')).toHaveLength(0);
    t += 2;
    await githubServerArgs(run, dir, { now });
    expect(calls.filter((c) => c.args[0] === 'repo')).toHaveLength(2);
  });

  it("an answer that isn't a plain hostname is no server", async () => {
    const dir = repo('odd', 'https://odd.example/acme/api.git');
    const { run } = ghWith({ [dir]: 'https://-oProxy=x/acme/api' });
    expect((await githubServerArgs(run, dir)).ok).toBe(false);
  });

  it("the review read, a thread's reply and resolve, and a review go to the repo's server", async () => {
    const dir = repo('ghe2', 'https://ghe.corp.example/acme/api.git');
    const { run, calls } = ghWith({ [dir]: 'https://ghe.corp.example/acme/api' });
    await githubReviewFeedback(run, dir, 7);
    await githubThreadReply(run, dir, 'PRRT_abcdef', 'thanks');
    await githubThreadResolve(run, dir, 'PRRT_abcdef');
    await github.submitReview!(run, dir, 7, { commitId: 'abc', event: 'comment', body: 'ok', comments: [] });
    const api = calls.filter((c) => c.args[0] === 'api');
    expect(api).toHaveLength(4);
    for (const c of api) {
      expect(c.args.slice(-2)).toEqual(['--hostname', 'ghe.corp.example']);
      expect(c.cwd).toBe(dir);
    }
  });

  it("a review on a repo whose server isn't known is refused clearly: nothing went out, so it isn't held in doubt", async () => {
    const dir = repo('ghe3', 'https://ghe3.corp.example/acme/api.git');
    const { run, calls } = ghWith({});
    const r = await github.submitReview!(run, dir, 7, { commitId: 'abc', event: 'approve', body: '', comments: [] });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/couldn't tell which GitHub server/) });
    expect(calls.filter((c) => c.args[0] === 'api')).toEqual([]);
  });
});

describe('who you are on GitHub Enterprise (#63 re-review: one login for github.com and GHE)', () => {
  it('the PR watch keeps one login per host and server: github.com and a GHE origin are asked apart, each once', async () => {
    const logins: Record<string, string> = { '/gh-a': 'me', '/gh-b': 'me', '/ghe': 'me-at-work' };
    const asked: string[] = [];
    const host = { id: 'github', viewer: async (_run: CommandRunner, cwd: string) => (asked.push(cwd), logins[cwd]) };
    const servers: Record<string, string> = { '/gh-a': 'github.com', '/gh-b': 'github.com', '/ghe': 'ghe.corp.example' };
    const viewer = viewerLogin(
      recorder(() => ({})).run,
      () => host,
      (p) => servers[p],
    );
    expect(await viewer(undefined, '/gh-a')).toBe('me');
    expect(await viewer(undefined, '/ghe')).toBe('me-at-work');
    expect(await viewer(undefined, '/gh-b')).toBe('me'); // github.com's, already known
    expect(await viewer(undefined, '/ghe')).toBe('me-at-work');
    expect(asked).toEqual(['/gh-a', '/ghe']);
  });
});

describe("a PR's existing discussion, read only (#64)", () => {
  let tmp: string;
  let dir: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-discussion-'));
    dir = path.join(tmp, 'api');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/api.git\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  beforeEach(() => clearGithubServers());

  const answer = {
    data: {
      repository: {
        pullRequest: {
          updatedAt: '2026-11-02T09:00:00Z',
          reviewThreads: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                id: 'PRRT_1',
                isResolved: false,
                isOutdated: false,
                path: 'src/Refund.cs',
                line: 12,
                originalLine: 10,
                diffSide: 'RIGHT',
                comments: {
                  totalCount: 2,
                  nodes: [
                    {
                      author: { login: 'ivo' },
                      authorAssociation: 'MEMBER',
                      body: 'Lock it?',
                      url: 'u1',
                      createdAt: '2026-11-01T10:00:00Z',
                    },
                    { author: null, authorAssociation: 'NONE', body: 'ok', url: 'u2', createdAt: '2026-11-01T11:00:00Z' },
                  ],
                },
              },
              {
                id: 'PRRT_2',
                isResolved: true,
                isOutdated: true,
                path: 'src/Old.cs',
                line: null,
                originalLine: 4,
                diffSide: 'LEFT',
                comments: {
                  totalCount: 1,
                  nodes: [{ author: { login: 'app/copilot' }, body: 'x'.repeat(5000), url: 'u3', createdAt: '' }],
                },
              },
              { id: 'PRRT_3', comments: { nodes: [] } },
              null,
            ],
          },
          reviews: {
            pageInfo: { hasPreviousPage: false },
            nodes: [
              {
                state: 'APPROVED',
                author: { login: 'ana' },
                authorAssociation: 'OWNER',
                body: '',
                url: 'v1',
                submittedAt: '2026-11-02T08:00:00Z',
              },
              { state: 'PENDING', author: { login: 'me' }, body: 'my draft' },
              { state: 'CHANGES_REQUESTED', author: { login: 'bo' }, body: 'Not yet.', url: 'v2', submittedAt: '2026-11-01T08:00:00Z' },
            ],
          },
          comments: {
            pageInfo: { hasPreviousPage: true },
            nodes: [
              { author: { login: 'lea' }, authorAssociation: 'MEMBER', body: 'Friday?', url: 'c1', createdAt: '2026-11-01T12:00:00Z' },
            ],
          },
        },
      },
    },
  };

  it('one GraphQL read (a query, never a mutation): threads with side, place, outdated and resolved; verdicts but not a pending review; conversation comments; updatedAt; more when a list stopped', async () => {
    const { run, calls } = recorder(() => ({ stdout: JSON.stringify(answer) }));
    const r = await github.discussion(run, dir, 7);
    expect(r.ok).toBe(true);
    const d = r.ok ? r.discussion : null;
    expect(d?.updatedAt).toBe('2026-11-02T09:00:00Z');
    expect(d?.more).toBe(true);
    expect(d?.threads).toHaveLength(2);
    expect(d?.threads[0]).toEqual({
      id: 'PRRT_1',
      path: 'src/Refund.cs',
      line: 12,
      originalLine: 10,
      side: 'right',
      outdated: false,
      resolved: false,
      url: 'u1',
      comments: [
        { author: 'ivo', association: 'MEMBER', body: 'Lock it?', at: '2026-11-01T10:00:00Z', url: 'u1' },
        { author: 'ghost', association: 'NONE', body: 'ok', at: '2026-11-01T11:00:00Z', url: 'u2' },
      ],
    });
    expect(d?.threads[1]).toMatchObject({ line: null, originalLine: 4, side: 'left', outdated: true, resolved: true });
    expect(d?.threads[1].comments[0].author).toBe('copilot');
    expect(d?.threads[1].comments[0].body).toContain('(cut: the rest is on the host)');
    expect(d?.reviews.map((x) => [x.author, x.state])).toEqual([
      ['ana', 'approved'],
      ['bo', 'changes-requested'],
    ]);
    expect(d?.comments).toEqual([{ author: 'lea', association: 'MEMBER', body: 'Friday?', at: '2026-11-01T12:00:00Z', url: 'c1' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('gh');
    expect(calls[0].args.slice(0, 2)).toEqual(['api', 'graphql']);
    const query = calls[0].args.find((a) => a.startsWith('query='))!;
    expect(query).toMatch(/^query=query\(/);
    expect(query).not.toMatch(/mutation/i);
  });

  it("gh's refusal comes back in its own words (the queue reads the API limit from them); an answer that isn't one is an error", async () => {
    const limited = await github.discussion(recorder(() => ({ code: 1, stderr: 'warning\nAPI rate limit already exceeded' })).run, dir, 7);
    expect(limited).toEqual({ ok: false, error: 'API rate limit already exceeded' });
    expect(github.rateLimited(limited.ok ? '' : limited.error)).toBe(true);
    expect((await github.discussion(recorder(() => ({ stdout: '{"data":{}}' })).run, dir, 7)).ok).toBe(false);
    expect(await github.discussion(recorder(() => ({ code: 127 })).run, dir, 7)).toEqual({ ok: false, error: 'GitHub CLI (gh) not found' });
  });

  it('openPrs carries updatedAt (what decides when a discussion is read again)', async () => {
    const { run, calls } = recorder(() => ({
      stdout: JSON.stringify([{ number: 7, headRefOid: 'a', updatedAt: '2026-11-02T09:00:00Z' }]),
    }));
    const r = await github.openPrs(run, '/repo');
    expect(r.ok && r.prs[0].updatedAt).toBe('2026-11-02T09:00:00Z');
    expect(calls[0].args.at(-1)).toContain('updatedAt');
  });
});

describe('which failed checks count: only the ones GitHub requires, when it requires any', () => {
  const view = (rollup: unknown[]) =>
    JSON.stringify({
      number: 3657,
      url: 'https://github.com/acme/api/pull/3657',
      state: 'OPEN',
      isDraft: false,
      mergeStateStatus: 'BLOCKED',
      headRefOid: 'abc',
      headRefName: 'fix/culture',
      statusCheckRollup: rollup,
    });
  const run = (o: { name: string; conclusion: string; detailsUrl?: string }) => ({ ...o, status: 'COMPLETED' });
  const rollup = [
    run({ name: 'Test', conclusion: 'SUCCESS' }),
    run({ name: 'OWASP Security Review', conclusion: 'FAILURE', detailsUrl: 'https://x/1' }),
  ];
  const gh = (required: Partial<RunResult>) =>
    recorder((_cmd, args) => (args[1] === 'checks' ? required : { code: 0, stdout: view(rollup) }));

  it('GitHub requires Test only: the failed scanner is set apart, the checks pass, and the host said so', async () => {
    const r = gh({ code: 0, stdout: JSON.stringify([{ name: 'Test' }]) });
    const got = await github.prForBranch(r.run, '/repo', 'fix/culture');
    expect(got).toMatchObject({
      kind: 'pr',
      pr: {
        checks: 'pass',
        optionalFailing: [{ name: 'OWASP Security Review', url: 'https://x/1' }],
        checksRequiredByHost: true,
        headBranch: 'fix/culture',
      },
    });
    expect(got.kind === 'pr' && got.pr.failing).toBeUndefined();
    // Asked only because a check failed, for that PR.
    expect(r.calls.find((c) => c.args[1] === 'checks')?.args).toEqual(['pr', 'checks', 'fix/culture', '--required', '--json', 'name']);
  });

  it('a required check that fails still counts (gh exits 1 with the list all the same)', async () => {
    const failing = [run({ name: 'Test', conclusion: 'FAILURE' }), run({ name: 'OWASP Security Review', conclusion: 'FAILURE' })];
    const r = recorder((_cmd, args) =>
      args[1] === 'checks' ? { code: 1, stdout: JSON.stringify([{ name: 'Test' }]) } : { code: 0, stdout: view(failing) },
    );
    expect(await github.prForBranch(r.run, '/repo', 'x')).toMatchObject({
      kind: 'pr',
      pr: { checks: 'fail', failing: [{ name: 'Test' }], optionalFailing: [{ name: 'OWASP Security Review' }] },
    });
  });

  it('GitHub requires none, or gh can’t say: every failed check counts (a repo’s config list may narrow it later)', async () => {
    for (const answer of [
      { code: 1, stderr: "no required checks reported on the 'fix/culture' branch" },
      { code: 1, stderr: 'HTTP 502' },
    ]) {
      const got = await github.prForBranch(gh(answer).run, '/repo', 'fix/culture');
      expect(got).toMatchObject({ kind: 'pr', pr: { checks: 'fail', failing: [{ name: 'OWASP Security Review' }] } });
      expect(got.kind === 'pr' && (got.pr.optionalFailing ?? got.pr.checksRequiredByHost)).toBeFalsy();
    }
  });

  it('passing checks: GitHub isn’t asked which are required', async () => {
    const r = recorder(() => ({ code: 0, stdout: view([run({ name: 'Test', conclusion: 'SUCCESS' })]) }));
    expect(await github.prForBranch(r.run, '/repo', 'x')).toMatchObject({ kind: 'pr', pr: { checks: 'pass' } });
    expect(r.calls.some((c) => c.args[1] === 'checks')).toBe(false);
  });

  it('a PR by its link is `gh pr view <link>`, which names its repo itself', async () => {
    const r = recorder(() => ({ code: 0, stdout: view([]) }));
    await github.prForRef(r.run, '/anywhere', { number: 3657, url: 'https://github.com/acme/api/pull/3657' });
    expect(r.calls[0].args.slice(0, 3)).toEqual(['pr', 'view', 'https://github.com/acme/api/pull/3657']);
  });
});
