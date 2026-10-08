import { describe, expect, it } from 'vitest';
import {
  fetchAllPullRequests,
  githubRepoOf,
  parsePrJson,
  parsePrSearch,
  type PrListDeps,
  type PullRequestInfo,
} from '../../../src/core/pr/pr.js';

const gh = (over: Record<string, unknown>) =>
  JSON.stringify([
    {
      number: 7,
      title: 't',
      headRefName: 'feat/x',
      url: 'u',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      author: { login: 'ana' },
      statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }],
      reviews: [],
      reviewRequests: [],
      ...over,
    },
  ]);

describe('parsePrJson', () => {
  it('a merge conflict is its own fact: green checks stay green', () => {
    const [pr] = parsePrJson(gh({ mergeable: 'CONFLICTING' }), 'api', 'ana');
    expect(pr).toMatchObject({ checksStatus: 'SUCCESS', conflicting: true, isMine: true });
    expect(parsePrJson(gh({}), 'api', 'ana')[0].conflicting).toBe(false);
  });

  it('review requested: only when you are asked by name', () => {
    expect(parsePrJson(gh({ reviewRequests: [{ login: 'Bo' }] }), 'api', 'bo')[0]).toMatchObject({ reviewRequested: true, isMine: false });
    expect(parsePrJson(gh({ reviewRequests: [{ login: 'cy' }, { name: 'core-team' }] }), 'api', 'bo')[0].reviewRequested).toBe(false);
    // Who you are unknown: nothing is asked of you, and nothing is yours.
    expect(parsePrJson(gh({ reviewRequests: [{ login: 'bo' }] }), 'api', '')[0]).toMatchObject({ reviewRequested: false, isMine: false });
  });

  it('failing checks still read as failing', () => {
    expect(parsePrJson(gh({ statusCheckRollup: [{ conclusion: 'FAILURE' }] }), 'api', 'ana')[0].checksStatus).toBe('FAILURE');
  });
});

const node = (over: Record<string, unknown> = {}) => ({
  number: 12,
  title: 'Fix it',
  url: 'https://github.com/acme/api/pull/12',
  isDraft: false,
  headRefName: 'fix/it',
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  author: { login: 'me' },
  repository: { nameWithOwner: 'acme/api' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviewRequests: { nodes: [] },
  latestReviews: { nodes: [] },
  ...over,
});
const search = (mine: unknown[], asked: unknown[] = [], counts: { mine?: number; asked?: number } = {}) =>
  JSON.stringify({
    data: {
      viewer: { login: 'me' },
      mine: { issueCount: counts.mine ?? mine.length, nodes: mine },
      asked: { issueCount: counts.asked ?? asked.length, nodes: asked },
    },
  });

describe('parsePrSearch (one GraphQL search instead of a list per repo)', () => {
  it('your PRs and the ones asking you, as the same rows gh pr list gave; unenrolled repos left out', () => {
    const { prs, incomplete } = parsePrSearch(
      search(
        [node(), node({ number: 13, repository: { nameWithOwner: 'acme/other' } })],
        [
          node({
            number: 40,
            author: { login: 'ana' },
            headRefName: 'feat/y',
            mergeable: 'CONFLICTING',
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'ERROR' } } }] },
            reviewRequests: { nodes: [{ requestedReviewer: { login: 'ME' } }] },
          }),
        ],
      ),
      (repo) => (repo === 'acme/api' ? ['api'] : []),
    );
    expect(incomplete).toBe(false);
    expect(prs.map((p) => `${p.repoAlias}#${p.number}`)).toEqual(['api#12', 'api#40']);
    expect(prs[0]).toMatchObject({ isMine: true, branch: 'fix/it', checksStatus: 'SUCCESS', reviewRequested: false, conflicting: false });
    expect(prs[1]).toMatchObject({ isMine: false, checksStatus: 'FAILURE', reviewRequested: true, conflicting: true });
    expect(prs[1]).toMatchObject({ author: 'ana', fork: false });
  });

  it("a fork's PR says so (its branch isn't on origin: nobody here can push to it)", () => {
    const { prs } = parsePrSearch(search([], [node({ author: { login: 'outsider' }, isCrossRepository: true })]), () => ['api']);
    expect(prs[0]).toMatchObject({ author: 'outsider', fork: true });
  });

  it('pending and no checks; your latest review; two aliases on one repo each get the PR', () => {
    const { prs } = parsePrSearch(
      search(
        [],
        [
          node({
            author: { login: 'ana' },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
            latestReviews: { nodes: [{ author: { login: 'me' }, state: 'COMMENTED' }] },
          }),
          node({ number: 14, commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
        ],
      ),
      () => ['ops', 'ops-old'],
    );
    expect(prs.map((p) => `${p.repoAlias}#${p.number}:${p.checksStatus}`)).toEqual([
      'ops#12:PENDING',
      'ops-old#12:PENDING',
      'ops#14:NONE',
      'ops-old#14:NONE',
    ]);
    expect(prs[0].myReview).toBe('COMMENTED');
  });

  it('more found than returned is incomplete', () => {
    expect(parsePrSearch(search([node()], [], { mine: 140 }), () => ['api']).incomplete).toBe(true);
  });
});

describe('githubRepoOf', () => {
  const cfg = (url: string) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
  it('github.com over https or ssh; another host or no origin is null', () => {
    expect(githubRepoOf(cfg('https://github.com/Acme/API.git'))).toBe('acme/api');
    expect(githubRepoOf(cfg('git@github.com:acme/api.git'))).toBe('acme/api');
    expect(githubRepoOf(cfg('https://ghe.example.com/acme/api.git'))).toBeNull();
    expect(githubRepoOf(cfg('https://notgithub.com/acme/api.git'))).toBeNull();
    expect(githubRepoOf('[core]\n')).toBeNull();
  });
});

describe('fetchAllPullRequests', () => {
  const origin = (url: string) => `[remote "origin"]\n\turl = ${url}\n`;
  const repos = { api: '/r/api', web: '/r/web', ghe: '/r/ghe' };
  const configs: Record<string, string> = {
    '/r/api': origin('git@github.com:acme/api.git'),
    '/r/web': origin('https://github.com/acme/web'),
    '/r/ghe': origin('https://ghe.example.com/acme/ghe.git'),
  };
  const row = (alias: string, number: number): PullRequestInfo => ({
    number,
    title: '',
    branch: `b${number}`,
    url: '',
    isDraft: false,
    checksStatus: 'NONE',
    reviewDecision: 'NONE',
    myReview: 'NONE',
    isMine: true,
    conflicting: false,
    reviewRequested: false,
    repoAlias: alias,
  });
  const deps = (over: Partial<PrListDeps> = {}) => {
    const listed: string[] = [];
    let searches = 0;
    const d: PrListDeps = {
      search: async () => (searches++, search([node({ number: 1, repository: { nameWithOwner: 'acme/web' }, headRefName: 'b1' })])),
      listRepo: async (_p, alias) => (listed.push(alias), [row(alias, 9)]),
      gitConfig: (p) => configs[p] ?? null,
      ...over,
    };
    return { d, listed, searches: () => searches };
  };

  it('one search for the GitHub repos; only a repo elsewhere is listed the old way', async () => {
    const { d, listed, searches } = deps();
    const { map, incomplete } = await fetchAllPullRequests(repos, d);
    expect(searches()).toBe(1);
    expect(listed).toEqual(['ghe']);
    expect(
      [...map.values()]
        .flat()
        .map((p) => `${p.repoAlias}#${p.number}`)
        .sort(),
    ).toEqual(['ghe#9', 'web#1']);
    expect(incomplete).toEqual([]);
  });

  it('a search that fails (old gh, offline): every repo the old way', async () => {
    const { d, listed } = deps({ search: async () => null });
    await fetchAllPullRequests(repos, d);
    expect(listed.sort()).toEqual(['api', 'ghe', 'web']);
    const garbled = deps({ search: async () => 'not json' });
    await fetchAllPullRequests(repos, garbled.d);
    expect(garbled.listed.sort()).toEqual(['api', 'ghe', 'web']);
  });

  it('no GitHub repo: no search at all', async () => {
    const { d, searches } = deps();
    await fetchAllPullRequests({ ghe: '/r/ghe' }, d);
    expect(searches()).toBe(0);
  });
});
