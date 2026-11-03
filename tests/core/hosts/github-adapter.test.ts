import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { github } from '../../../src/core/hosts/github/adapter.js';
import { fetchAllPullRequests } from '../../../src/core/pr/pr.js';
import type { CommandRunner, RunResult } from '../../../src/core/platform/command-runner.js';
import { registerHost } from '../../../src/core/hosts/index.js';
import type { GitHost } from '../../../src/core/hosts/types.js';
import { enterpriseHostname, githubViewer } from '../../../src/core/hosts/github/review.js';
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
    const { run, calls } = recorder((cmd, args) =>
      args[0] === 'pr' ? { stdout: JSON.stringify([{ number: 3, headRefName: 'b3', author: { login: 'me' } }]) } : { stdout: 'me\n' },
    );
    const { map } = await fetchAllPullRequests({ ghe }, { run });
    expect(map.get('b3')?.[0]).toMatchObject({ repoAlias: 'ghe', number: 3, isMine: true });
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

describe('who you are on GitHub Enterprise (#63 re-review: one login for github.com and GHE)', () => {
  const config = (origin: string | null) => () => (origin ? `[remote "origin"]\n\turl = ${origin}\n` : null);

  it("enterpriseHostname: a GHE origin's server; none for github.com, an SSH alias of it, no origin or a name gh mustn't get", () => {
    expect(enterpriseHostname('https://ghe.corp.example/acme/api.git')).toBe('ghe.corp.example');
    expect(enterpriseHostname('git@ghe.corp.example:acme/api.git')).toBe('ghe.corp.example');
    expect(enterpriseHostname('git@github.com:acme/api.git')).toBeNull();
    expect(enterpriseHostname('ssh://git@ssh.github.com:443/acme/api.git')).toBeNull();
    expect(enterpriseHostname('git@github-work:acme/api.git')).toBeNull(); // an alias in ~/.ssh/config
    expect(enterpriseHostname(null)).toBeNull();
    expect(enterpriseHostname('ssh://-oProxy.example/x')).toBeNull();
  });

  it("gh api user is asked of the repo's server: --hostname for GHE, nothing extra for github.com", async () => {
    const { run, calls } = recorder(() => ({ stdout: 'ana\n' }));
    expect(await githubViewer(run, '/ghe-repo', config('https://ghe.corp.example/acme/api.git'))).toBe('ana');
    expect(await githubViewer(run, '/gh-repo', config('git@github.com:acme/api.git'))).toBe('ana');
    expect(calls.map((c) => [c.args, c.cwd])).toEqual([
      [['api', 'user', '--jq', '.login', '--hostname', 'ghe.corp.example'], '/ghe-repo'],
      [['api', 'user', '--jq', '.login'], '/gh-repo'],
    ]);
  });

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
