import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GitHost } from '../../../src/core/hosts/types.js';
import { hostForOrigin, hostForRepo, hostOfThread, originHostname, registerHost } from '../../../src/core/hosts/index.js';
import { commandsFor, hostName } from '../../../src/core/hosts/commands.js';
import type { PullRequestInfo } from '../../../src/core/pr/pr-types.js';
import type { ShipPr, SessionCi } from '../../../src/core/api-types.js';
import type { ReviewFeedback } from '../../../src/core/pr/review-types.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';
import { fetchAllPullRequests } from '../../../src/core/pr/pr.js';
import { mergeSelected, shipPreflight, defaultRunner } from '../../../src/core/pr/ship.js';
import { createPrWatch } from '../../../src/core/pr/pr-watch.js';
import { fetchReviewFeedback } from '../../../src/core/pr/pr-review.js';
import { prStageOf } from '../../../src/core/pr/pr-stage.js';
import { listReplies, postReply, rememberSent, saveDraft, threadRefusal } from '../../../src/core/pr/pr-replies.js';
import { blockedPrState, blockRefFrom } from '../../../src/core/rail/session-blocks.js';
import { resolvePrToStart } from '../../../src/core/pr/pr-start.js';
import { workOnPrPrompt } from '../../../src/core/pr/pr-ref.js';
import { prPrompt } from '../../../src/web/src/state/start-prompts.js';
import { commitsWrittenOn } from '../../../src/core/time/time-deps.js';

/**
 * #63's proof that work is ready for another git host: a made-up one
 * ("Fakehub": its own CLI name, link format, thread ids and words) drives
 * the PR list, Ship, the PR watch and its stages, reply drafts, blockers and
 * Start from a PR through the GitHost interface — and a group whose two
 * repos are on two different hosts. Nothing here calls gh: the repos are real
 * git (Ship reads them), their origins on the fake hosts' domains, pushes
 * going to a local bare repo through `url.<bare>.insteadOf`.
 */

const NO_GITHUB = /GitHub|\bgh\b/;

interface FakeState {
  prs: Map<string, ShipPr>; // by branch
  list: PullRequestInfo[];
  merged: Array<{ number: number; method: string; headSha: string }>;
  feedback: ReviewFeedback | null;
  threads: Map<string, { resolved: boolean; lastAuthor: string }>;
  replies: Array<{ id: string; body: string }>;
  resolved: string[];
  prStates: Map<string, 'OPEN' | 'MERGED' | 'CLOSED'>;
  limited: boolean;
}

function fakeHost(id: string, name: string, domain: string, cli: string): { host: GitHost; state: FakeState } {
  const state: FakeState = {
    prs: new Map(),
    list: [],
    merged: [],
    feedback: null,
    threads: new Map(),
    replies: [],
    resolved: [],
    prStates: new Map(),
    limited: false,
  };
  const linkRe = new RegExp(`^https://${domain.replace(/\./g, '\\.')}/([\\w-]+/[\\w-]+)/pr/(\\d+)$`);
  const host: GitHost = {
    id,
    name,
    cli: { cmd: cli, label: `${name} CLI`, checkArgs: ['whoami'], missing: `Optional: install ${cli}.`, failing: `Run ${cli} login.` },
    matches: (o) => o.includes(`//${domain}/`),
    repoId: (o) => /\/\/[^/]+\/([\w-]+\/[\w-]+?)(?:\.git)?$/.exec(o)?.[1].toLowerCase() ?? null,
    parsePrUrl: (t) => {
      const m = linkRe.exec(t.trim());
      return m ? { repoId: m[1].toLowerCase(), number: Number(m[2]), url: t.trim(), label: `${m[1].split('/')[1]}!${m[2]}` } : null;
    },
    prRef: (n) => `refs/${id}/${n}`,
    list: async (repos) => ({ prs: state.list.filter((p) => repos.some((r) => r.alias === p.repoAlias)), incomplete: [] }),
    viewer: async () => 'me',
    prForBranch: async (_run, _cwd, branch) => {
      if (state.limited) return { kind: 'error', error: `${name} says: slow down` };
      const pr = state.prs.get(branch);
      return pr ? { kind: 'pr', pr } : { kind: 'none' };
    },
    prByNumber: async (_run, _cwd, _repoId, number) => ({
      ok: true,
      pr: {
        number,
        title: 'Add refunds',
        url: `https://${domain}/team/api/pr/${number}`,
        branch: 'feat/refunds',
        base: 'main',
        author: 'ana',
        state: 'OPEN',
      },
    }),
    prState: async (_run, url) =>
      state.prStates.has(url) ? { ok: true, state: state.prStates.get(url)! } : { ok: false, error: 'unknown' },
    createPr: async () => ({ ok: true, url: `https://${domain}/team/api/pr/99` }),
    mergePr: async (_run, _cwd, number, method, headSha) => {
      state.merged.push({ number, method, headSha });
      return { ok: true };
    },
    mergedPr: async () => null,
    openPrs: async () => ({ ok: true, prs: [] }),
    postReviewComment: async () => ({ ok: true }),
    submitReview: async () => ({ ok: true }),
    reviewFeedback: async () => state.feedback,
    threads: {
      isId: (t) => new RegExp(`^${id.toUpperCase()}-\\d+$`).test(t),
      now: async (_run, _cwd, t) => {
        const th = state.threads.get(t);
        return th
          ? { ok: true, thread: { viewer: 'me', resolved: th.resolved, lastAuthor: th.lastAuthor } }
          : { ok: false, error: 'no thread' };
      },
      live: async () => ({ ok: false, error: 'not here' }),
      isResolved: async (_run, _cwd, t) => state.threads.get(t)?.resolved ?? null,
      reply: async (_run, _cwd, t, body) => {
        state.replies.push({ id: t, body });
        return { ok: true, url: `https://${domain}/team/api/pr/7#${t}` };
      },
      resolve: async (_run, _cwd, t) => {
        state.resolved.push(t);
        return true;
      },
    },
    rateLimited: (text) => /slow down/.test(text),
    hostCommit: (email) => email === `robot@${domain}`,
    commands: {
      host: name,
      cli,
      view: (n) => `${cli} show ${n}`,
      comments: (n) => `${cli} show ${n} --talk`,
      diff: (n) => `${cli} changes ${n}`,
      checks: (n) => `${cli} builds ${n}`,
      failedLog: `${cli} build-log <build>`,
      checkout: (n, detach) => `${cli} fetch ${n}${detach ? ' --detached' : ''}`,
      create: `${cli} open`,
    },
  };
  return { host, state };
}

const fake = fakeHost('fake', 'Fakehub', 'code.fake.example', 'fk');
const other = fakeHost('other', 'Otherhub', 'git.other.example', 'oth');
const unregister: Array<() => void> = [];

let tmp: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

/** A repo whose origin is on `origin` (a fake host's URL), pushing to a local bare repo; on `branch`, pushed, one commit past main. */
function repoOn(name: string, origin: string, branch: string): { path: string; head: string } {
  const bare = path.join(tmp, `${name}.git`);
  const work = path.join(tmp, name);
  git(tmp, 'init', '--bare', '-q', '-b', 'main', bare);
  git(tmp, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [
    ['user.email', 'me@example.com'],
    ['user.name', 'Me'],
    ['commit.gpgsign', 'false'],
    [`url.${bare.split(path.sep).join('/')}.insteadOf`, origin],
  ])
    git(work, 'config', k, v);
  git(work, 'remote', 'add', 'origin', origin);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', branch);
  fs.writeFileSync(path.join(work, 'b.txt'), 'two\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'the change');
  git(work, 'push', '-q', '-u', 'origin', branch);
  return { path: work, head: git(work, 'rev-parse', 'HEAD') };
}

let api: { path: string; head: string };
let web: { path: string; head: string };
let group: WorktreeSession;

const openPr = (number: number, headSha: string, over: Partial<ShipPr> = {}): ShipPr => ({
  number,
  url: `https://code.fake.example/team/api/pr/${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  checks: 'pass',
  headSha,
  reviewDecision: 'APPROVED',
  author: 'me',
  baseBranch: 'main',
  ...over,
});

beforeAll(() => {
  unregister.push(registerHost(fake.host), registerHost(other.host));
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-host-')));
  api = repoOn('api', 'https://code.fake.example/team/api.git', 'feat/refunds');
  web = repoOn('web', 'https://git.other.example/team/web.git', 'feat/refunds');
  group = {
    target: 'shop',
    isGroup: true,
    branch: 'feat/refunds',
    paths: [api.path, web.path],
    repos: ['api', 'web'],
    createdAt: '2026-11-01T00:00:00Z',
    lastAccessedAt: '2026-11-01T00:00:00Z',
  };
}, 60_000);

afterAll(() => {
  for (const u of unregister) u();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a repo is on the host its origin says', () => {
  it('each repo resolves on its own; nobody claims a plain server, which is asked as GitHub (as before hosts)', () => {
    expect(hostForRepo(api.path).host.id).toBe('fake');
    expect(hostForRepo(web.path).host.id).toBe('other');
    expect(hostForOrigin('https://github.com/acme/api.git').id).toBe('github');
    expect(hostForOrigin('git@git.internal:acme/api.git').id).toBe('github');
    expect(hostForOrigin(null).id).toBe('github');
  });

  it('config gitHosts names the host of an origin the URL cannot tell (by its hostname)', () => {
    const overrides = () => new Map([['git.internal', 'fake']]);
    expect(hostForOrigin('git@git.internal:acme/api.git', { overrides }).id).toBe('fake');
    expect(hostForOrigin('https://user@git.internal/acme/api', { overrides }).id).toBe('fake');
    expect(originHostname('ssh://git@git.internal:2222/acme/api')).toBe('git.internal');
    expect(originHostname('/c/repos/local')).toBeNull();
  });

  it('a thread id belongs to the host whose shape it has; its name and commands come with it', () => {
    expect(hostOfThread('FAKE-12')?.id).toBe('fake');
    expect(hostOfThread('OTHER-3')?.id).toBe('other');
    expect(hostOfThread('PRRT_kwDOabc123')?.id).toBe('github');
    expect(hostOfThread('nope')).toBeNull();
    expect(hostName('fake')).toBe('Fakehub');
    expect(commandsFor('fake').checks(4)).toBe('fk builds 4');
    expect(commandsFor('nobody').cli).toBe('gh'); // an unknown id (an older server's row): GitHub's
  });
});

describe('the PR list', () => {
  it('a group on two hosts: each repo listed by its own host, each PR saying which', async () => {
    const row = (alias: string, number: number): PullRequestInfo => ({
      number,
      title: `PR ${number}`,
      branch: 'feat/refunds',
      url: `u${number}`,
      isDraft: false,
      checksStatus: 'SUCCESS',
      reviewDecision: 'NONE',
      myReview: 'NONE',
      isMine: true,
      conflicting: false,
      reviewRequested: false,
      repoAlias: alias,
    });
    fake.state.list = [row('api', 7)];
    other.state.list = [row('web', 8)];
    const { map, incomplete } = await fetchAllPullRequests({ api: api.path, web: web.path });
    expect(incomplete).toEqual([]);
    expect(map.get('feat/refunds')?.map((p) => [p.repoAlias, p.number, p.host])).toEqual([
      ['api', 7, 'fake'],
      ['web', 8, 'other'],
    ]);
  });
});

describe('Ship', () => {
  it("reads each repo's PR from its own host, and merges each through it with the head you were shown", async () => {
    fake.state.prs.set('feat/refunds', openPr(7, api.head));
    other.state.prs.set('feat/refunds', openPr(8, web.head, { url: 'https://git.other.example/team/web/pr/8' }));
    const pre = await shipPreflight(group, defaultRunner);
    expect(pre.repos.map((r) => [r.name, r.host, r.pr?.number, r.mergeBlockers])).toEqual([
      ['api', 'fake', 7, []],
      ['web', 'other', 8, []],
    ]);
    const out = await mergeSelected(
      group,
      [
        { name: 'api', headSha: api.head },
        { name: 'web', headSha: web.head },
      ],
      'squash',
      defaultRunner,
    );
    expect(out.results.map((r) => [r.repo, r.ok])).toEqual([
      ['api', true],
      ['web', true],
    ]);
    expect(fake.state.merged).toEqual([{ number: 7, method: 'squash', headSha: api.head }]);
    expect(other.state.merged).toEqual([{ number: 8, method: 'squash', headSha: web.head }]);
  }, 60_000);
});

describe('the PR watch, its stage and its notes', () => {
  const watch = (told: string[]) =>
    createPrWatch({
      sessions: () => [{ id: 'shop1', session: group }],
      preflight: (s) => shipPreflight(s, defaultRunner),
      archive: async () => undefined,
      tell: async (_id, body) => void told.push(body),
      broadcast: () => undefined,
      options: () => ({ autoArchive: false, fixCi: true, reviewComments: true }),
      viewer: async (host) => (host === 'other' ? 'me-on-other' : 'me'),
      reviewFeedback: (repoPath, n) => fetchReviewFeedback(repoPath, n, defaultRunner),
      told: () => {
        const seen = new Set<string>();
        return { has: (k) => seen.has(k), add: (k) => void seen.add(k) };
      },
    });

  it("failing checks and review threads on Fakehub: the stage, and notes in Fakehub's words — never GitHub's", async () => {
    fake.state.limited = false;
    fake.state.prs.set('feat/refunds', openPr(7, api.head, { checks: 'fail', failing: [{ name: 'build' }] }));
    other.state.prs.set('feat/refunds', openPr(8, web.head, { author: 'me-on-other' }));
    fake.state.feedback = {
      viewer: 'me',
      threads: [
        {
          id: 'FAKE-1',
          isResolved: false,
          isOutdated: false,
          path: 'a.txt',
          line: 1,
          comments: [
            {
              id: 'c1',
              author: 'rev',
              association: 'MEMBER',
              body: 'Rename this',
              url: 'https://code.fake.example/c1',
              createdAt: '2026-11-01T00:00:00Z',
            },
          ],
        },
      ],
      reviews: [],
      comments: [],
    };
    other.state.feedback = { viewer: 'me-on-other', threads: [], reviews: [], comments: [] };
    const told: string[] = [];
    const ci = (await watch(told).refresh('shop1')) as SessionCi;
    expect(ci.repos.map((r) => [r.name, r.host, r.openThreads])).toEqual([
      ['api', 'fake', 1],
      ['web', 'other', 0],
    ]);
    expect(prStageOf(ci.repos)?.kind).toBe('checks_failing');
    const review = told.find((t) => t.startsWith('New review feedback'))!;
    const ciNote = told.find((t) => t.startsWith('CI is failing'))!;
    expect(review).toContain('on Fakehub');
    expect(review).toContain('[thread FAKE-1]');
    expect(ciNote).toContain('`fk builds <n>`');
    for (const t of told) expect(t).not.toMatch(NO_GITHUB);
  }, 60_000);

  it("the host's own words for its API limit: the watch keeps what it knew and tells nobody", async () => {
    const told: string[] = [];
    const w = watch(told);
    fake.state.prs.set('feat/refunds', openPr(7, api.head));
    const first = await w.refresh('shop1');
    fake.state.limited = true;
    told.length = 0;
    expect(await w.refresh('shop1')).toEqual(first);
    expect(told).toEqual([]);
    fake.state.limited = false;
  }, 60_000);
});

describe('reply drafts', () => {
  it('a Fakehub thread is drafted, checked and posted through Fakehub; your own last word is refused', async () => {
    rememberSent('shop1', [
      {
        threadId: 'FAKE-1',
        repo: 'api',
        prNumber: 7,
        url: 'https://code.fake.example/c1',
        where: 'a.txt:1',
        reviewer: 'rev',
        excerpt: 'Rename this',
      },
    ]);
    expect(listReplies('shop1').map((r) => r.threadId)).toEqual(['FAKE-1']);
    expect(saveDraft('shop1', 'FAKE-1', 'Renamed.').ok).toBe(true);
    fake.state.threads.set('FAKE-1', { resolved: false, lastAuthor: 'me' });
    expect(await threadRefusal('FAKE-1', api.path, defaultRunner)).toMatch(/already yours/);
    fake.state.threads.set('FAKE-1', { resolved: false, lastAuthor: 'rev' });
    const r = await postReply('shop1', 'FAKE-1', 'Renamed.', { resolve: true, cwd: api.path, run: defaultRunner });
    expect(r).toEqual({ ok: true, url: 'https://code.fake.example/team/api/pr/7#FAKE-1', resolved: true });
    expect(fake.state.replies).toEqual([{ id: 'FAKE-1', body: 'Renamed.' }]);
    expect(fake.state.resolved).toEqual(['FAKE-1']);
  });
});

describe('blocked by a PR on another host', () => {
  it('a Fakehub link is a blocker, and its state is asked of Fakehub', async () => {
    const url = 'https://code.fake.example/team/api/pr/7';
    expect(blockRefFrom({ kind: 'pr', url })).toEqual({ kind: 'pr', url, label: 'api!7' });
    fake.state.prStates.set(url, 'MERGED');
    expect(await blockedPrState(url, defaultRunner)).toEqual({ state: 'MERGED' });
  });
});

describe('Start from a PR, and what its session is told', () => {
  it("a Fakehub link finds its repo by origin; the prompts use Fakehub's commands", async () => {
    const r = await resolvePrToStart('https://code.fake.example/team/api/pr/12', { repos: { api: api.path, web: web.path }, groups: {} });
    expect(r).toMatchObject({ ok: true, pr: { alias: 'api', number: 12, branch: 'feat/refunds', host: 'fake' } });
    const first = workOnPrPrompt({ number: 12, title: 'Add refunds', url: 'u', author: 'ana', host: 'fake' });
    expect(first).toContain('fk show 12');
    expect(first).toContain("Don't post on Fakehub");
    const review = prPrompt({
      number: 12,
      title: 'Add refunds',
      branch: 'feat/refunds',
      url: 'u',
      isDraft: false,
      checksStatus: 'FAILURE',
      reviewDecision: 'CHANGES_REQUESTED',
      myReview: 'NONE',
      isMine: true,
      repoAlias: 'api',
      host: 'fake',
    });
    const theirs = prPrompt({
      ...{
        number: 13,
        title: 'x',
        branch: 'b',
        url: 'u',
        isDraft: false,
        checksStatus: 'NONE',
        reviewDecision: 'NONE',
        myReview: 'NONE',
        isMine: false,
        repoAlias: 'api',
        fork: true,
        host: 'fake',
      },
    });
    for (const t of [first, review, theirs]) expect(t).not.toMatch(NO_GITHUB);
    expect(review).toContain('fk builds 12');
    expect(theirs).toContain('fk fetch 13 --detached');
  });

  it("a day's commits leave out the ones a host wrote itself (a squash merge), whichever host", () => {
    const day = new Date().toISOString().slice(0, 10);
    const at = new Date().toISOString();
    const log = [
      `a1\t${at}\tme@example.com\tmine`,
      `b2\t${at}\trobot@code.fake.example\tSquash`,
      `c3\t${at}\tnoreply@github.com\tMerge`,
    ].join('\n');
    expect(commitsWrittenOn(log, day).map((c) => c.sha)).toEqual(['a1']);
  });
});
