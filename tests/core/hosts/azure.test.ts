import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { azReason, azure, routeValueOk } from '../../../src/core/hosts/azure/adapter.js';
import { azureRepoId, azureThreadId, parseAzureOrigin, parseAzurePrUrl, parseAzureThreadId } from '../../../src/core/hosts/azure/origin.js';
import { checksOf, feedbackOf, mergeState, reviewDecision, type AzPr } from '../../../src/core/hosts/azure/map.js';
import { hostForOrigin, hostOfPrUrl, hostOfThread } from '../../../src/core/hosts/index.js';
import { parsePrLink, threadHostId } from '../../../src/core/hosts/links.js';
import { commandsFor } from '../../../src/core/hosts/commands.js';
import { defaultRunner, type CommandRunner, type RunResult } from '../../../src/core/platform/command-runner.js';
import { mergeSelected, shipPreflight } from '../../../src/core/pr/ship.js';
import { fetchAllPullRequests } from '../../../src/core/pr/pr.js';
import { createPrWatch } from '../../../src/core/pr/pr-watch.js';
import { prWatchHostDeps, watchAskGh } from '../../../src/core/pr/pr-watch-hosts.js';
import { prStageOf } from '../../../src/core/pr/pr-stage.js';
import { liveOpenThread, postReply, rememberSent, threadRefusal } from '../../../src/core/pr/pr-replies.js';
import { blockedPrState, blockRefFrom } from '../../../src/core/rail/session-blocks.js';
import { resolvePrToStart } from '../../../src/core/pr/pr-start.js';
import type { SessionCi } from '../../../src/core/api-types.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

/**
 * #65: Azure DevOps through `az`. The fixtures are az's JSON in the shapes
 * Azure DevOps documents (made by hand: no Azure DevOps here to record
 * from); a runner answers `az` from them and passes git through, so the same
 * flows the fake-host suite drives — the PR list, Ship, the PR watch and its
 * stage, reply drafts, blockers, Start from a PR — run through the adapter
 * on a real repo whose origin is on Azure DevOps.
 */

const ORIGIN = 'https://dev.azure.com/acme/Shop/_git/api';
const ORG = 'https://dev.azure.com/acme';
const ME = 'me@acme.example';

describe('Azure DevOps origins, links and thread ids', () => {
  it.each([
    ['https://dev.azure.com/acme/Shop/_git/api', 'https://dev.azure.com/acme'],
    ['https://me@dev.azure.com/acme/Shop/_git/api', 'https://dev.azure.com/acme'],
    ['https://acme.visualstudio.com/Shop/_git/api', 'https://acme.visualstudio.com'],
    ['https://acme.visualstudio.com/DefaultCollection/Shop/_git/api', 'https://acme.visualstudio.com'],
    ['git@ssh.dev.azure.com:v3/acme/Shop/api', 'https://dev.azure.com/acme'],
    ['acme@vs-ssh.visualstudio.com:v3/acme/Shop/api', 'https://acme.visualstudio.com'],
  ])('%s', (origin, orgUrl) => {
    expect(parseAzureOrigin(origin)).toEqual({ org: 'acme', project: 'Shop', repo: 'api', orgUrl });
    expect(azureRepoId(origin)).toBe('acme/shop/api');
    expect(hostForOrigin(origin).id).toBe('azure');
  });

  it('a project with spaces; GitHub and other servers are not Azure DevOps', () => {
    expect(parseAzureOrigin('https://dev.azure.com/acme/My%20Shop/_git/api')?.project).toBe('My Shop');
    expect(parseAzureOrigin('https://github.com/acme/api.git')).toBeNull();
    expect(hostForOrigin('https://github.com/acme/api.git').id).toBe('github');
  });

  it('a PR link: its repo and number, read by the pure readers and the registry alike', () => {
    const url = 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/42?_a=files';
    expect(parseAzurePrUrl(url)).toMatchObject({
      repoId: 'acme/shop/api',
      number: 42,
      url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/42',
      label: 'api!42',
    });
    expect(parsePrLink(url)).toMatchObject({ host: 'azure', number: 42 });
    expect(hostOfPrUrl(url)?.host.id).toBe('azure');
  });

  it('a thread id carries its repo, PR and thread, and routes to Azure DevOps', () => {
    const repo = { orgUrl: ORG, project: 'My Shop', repo: 'api' };
    const id = azureThreadId(repo, 42, 7);
    expect(id).toMatch(/^AZT_/);
    expect(parseAzureThreadId(id)).toEqual({ repo, pr: 42, thread: 7 });
    expect(hostOfThread(id)?.id).toBe('azure');
    expect(threadHostId(id)).toBe('azure');
    expect(parseAzureThreadId('AZT_nope_1_2')).toBeNull();
  });

  it("prompts get az's commands, never gh", () => {
    const c = commandsFor('azure');
    expect(c.host).toBe('Azure DevOps');
    expect(c.view(42)).toBe('az repos pr show --id 42');
    expect(c.diff(42)).toContain('refs/pull/42/merge');
    expect(
      Object.values(c)
        .map((v) => (typeof v === 'function' ? v(42) : v))
        .join(' '),
    ).not.toMatch(/\bgh\b|GitHub/);
  });
});

describe('Azure DevOps answers in work’s words', () => {
  const pr = (reviewers: AzPr['reviewers']): AzPr => ({ pullRequestId: 1, reviewers });
  it('votes: 10 / 5 approve, −5 and −10 ask for changes, required reviewers must all approve', () => {
    expect(reviewDecision(pr([]))).toBe('');
    expect(reviewDecision(pr([{ vote: 10 }]))).toBe('APPROVED');
    expect(reviewDecision(pr([{ vote: 5 }, { vote: 0 }]))).toBe('APPROVED');
    expect(reviewDecision(pr([{ vote: 10 }, { vote: -5 }]))).toBe('CHANGES_REQUESTED');
    expect(reviewDecision(pr([{ vote: -10 }]))).toBe('CHANGES_REQUESTED');
    expect(reviewDecision(pr([{ vote: 10 }, { vote: 0, isRequired: true }]))).toBe('REVIEW_REQUIRED');
  });

  it('build policies are the checks; conflicts are DIRTY; a blocking policy not met blocks', () => {
    const build = (status: string, name = 'CI') => ({
      status,
      configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: name } },
    });
    const reviewers = (status: string) => ({
      status,
      configuration: { isBlocking: true, type: { displayName: 'Minimum number of reviewers' } },
    });
    expect(checksOf([])).toEqual({ checks: 'none', failing: [] });
    expect(checksOf([build('approved')])).toEqual({ checks: 'pass', failing: [] });
    expect(checksOf([build('running')])).toEqual({ checks: 'pending', failing: [] });
    expect(checksOf([build('approved'), build('rejected', 'unit tests')])).toEqual({ checks: 'fail', failing: [{ name: 'unit tests' }] });
    expect(mergeState({ mergeStatus: 'conflicts' }, [])).toBe('DIRTY');
    expect(mergeState({ isDraft: true }, [])).toBe('DRAFT');
    expect(mergeState({}, [build('approved'), reviewers('queued')])).toBe('BLOCKED');
    expect(mergeState({}, [build('approved'), reviewers('approved')])).toBe('CLEAN');
  });

  it("threads: people's comments only, resolved by status, on their file and line", () => {
    const repo = { org: 'acme', project: 'Shop', repo: 'api', orgUrl: ORG };
    const fb = feedbackOf(
      repo,
      42,
      [
        {
          id: 1,
          status: 'active',
          threadContext: { filePath: '/src/a.cs', rightFileEnd: { line: 12 } },
          comments: [{ id: 1, author: { uniqueName: 'rev@acme.example' }, content: 'Rename', publishedDate: 'd', commentType: 'text' }],
        },
        { id: 2, status: 'fixed', comments: [{ id: 1, author: { uniqueName: 'rev@acme.example' }, content: 'ok', commentType: 'text' }] },
        { id: 3, status: 'active', comments: [{ id: 1, content: 'Policy updated', commentType: 'system' }] },
        { id: 4, isDeleted: true, comments: [{ id: 1, content: 'x' }] },
      ],
      ME,
    );
    expect(fb.threads.map((t) => [parseAzureThreadId(t.id)?.thread, t.isResolved, t.path, t.line, t.comments[0].association])).toEqual([
      [1, false, 'src/a.cs', 12, 'MEMBER'],
      [2, true, null, null, 'MEMBER'],
    ]);
    expect(fb.viewer).toBe(ME);
  });
});

// ---- the adapter on a real repo, az answered from fixtures ----

let tmp: string;
let api: { path: string; head: string };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

interface AzState {
  prs: AzPr[];
  policies: unknown[];
  threads: unknown[];
  /** The PR's pushes (null: one, at the branch's head). */
  iterations: unknown[] | null;
  patched: unknown[];
  posted: unknown[];
  limited: boolean;
  /** What the completing PATCH answers as the PR's status. */
  completeAs: string;
  /** These az commands fail (their first words, e.g. 'account show'), with this stderr. */
  failing: Record<string, string>;
  calls: string[][];
}
const fresh = (): AzState => ({
  prs: [],
  policies: [],
  threads: [],
  iterations: null,
  patched: [],
  posted: [],
  limited: false,
  completeAs: 'completed',
  failing: {},
  calls: [],
});
const az: AzState = fresh();
// Every test starts from the same fixtures: none leaks into the next.
beforeEach(() => Object.assign(az, fresh()));

/** git through, az from the fixtures (bodies read from the --in-file before it's deleted). */
const run: CommandRunner = async (cmd, args, cwd): Promise<RunResult> => {
  if (cmd !== 'az') return defaultRunner(cmd, args, cwd);
  az.calls.push(args);
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
  if (az.limited) return { code: 1, stdout: '', stderr: 'WARNING: a newer az is out\nTF400733: The request was blocked' };
  const a = args.join(' ');
  const failed = Object.keys(az.failing).find((k) => a.startsWith(k));
  if (failed) return { code: 1, stdout: '', stderr: az.failing[failed] };
  const inFile = args.includes('--in-file') ? JSON.parse(fs.readFileSync(args[args.indexOf('--in-file') + 1], 'utf8')) : undefined;
  if (a.startsWith('account show')) return ok({ user: { name: ME } });
  if (a.startsWith('repos pr policy list')) return ok(az.policies);
  if (a.startsWith('repos pr list')) {
    const branch = args.includes('--source-branch') ? args[args.indexOf('--source-branch') + 1] : null;
    const status = args[args.indexOf('--status') + 1];
    return ok(az.prs.filter((p) => (!branch || p.sourceRefName === `refs/heads/${branch}`) && (status === 'all' || p.status === status)));
  }
  if (a.startsWith('repos pr show')) return ok(az.prs.find((p) => String(p.pullRequestId) === args[args.indexOf('--id') + 1]) ?? {});
  if (a.startsWith('devops invoke')) {
    const resource = args[args.indexOf('--resource') + 1];
    const method = args[args.indexOf('--http-method') + 1];
    if (resource === 'pullRequests' && method === 'PATCH') {
      az.patched.push(inFile);
      return ok({ pullRequestId: 7, status: az.completeAs, mergeStatus: 'queued' });
    }
    if (resource === 'pullRequestIterations') return ok({ value: az.iterations ?? [{ id: 1, sourceRefCommit: { commitId: api.head } }] });
    if (resource === 'repositories') return ok({ id: 'guid', name: 'api', defaultBranch: 'refs/heads/main' });
    if (resource === 'pullRequests' && method === 'POST') {
      az.posted.push({ resource, method, body: inFile });
      return ok({ pullRequestId: 12, status: 'active' });
    }
    if (resource === 'pullRequestThreads' && method === 'GET') {
      const tid = args.find((x) => x.startsWith('threadId='));
      return ok(tid ? az.threads.find((t) => `threadId=${(t as { id: number }).id}` === tid) : { value: az.threads });
    }
    az.posted.push({ resource, method, body: inFile });
    return ok({ id: 99 });
  }
  return { code: 1, stdout: '', stderr: `unexpected az ${a}` };
};

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'azure-host-')));
  const bare = path.join(tmp, 'api.git');
  const work = path.join(tmp, 'api');
  git(tmp, 'init', '--bare', '-q', '-b', 'main', bare);
  git(tmp, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [
    ['user.email', ME],
    ['user.name', 'Me'],
    ['commit.gpgsign', 'false'],
    [`url.${bare.split(path.sep).join('/')}.insteadOf`, ORIGIN],
  ])
    git(work, 'config', k, v);
  git(work, 'remote', 'add', 'origin', ORIGIN);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  git(work, 'remote', 'set-head', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feat/refunds');
  fs.writeFileSync(path.join(work, 'b.txt'), 'two\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'Add refunds');
  git(work, 'push', '-q', '-u', 'origin', 'feat/refunds');
  api = { path: work, head: git(work, 'rev-parse', 'HEAD') };
}, 60_000);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const prOf = (over: Partial<AzPr> = {}): AzPr => ({
  pullRequestId: 7,
  title: 'Add refunds',
  status: 'active',
  isDraft: false,
  mergeStatus: 'succeeded',
  sourceRefName: 'refs/heads/feat/refunds',
  targetRefName: 'refs/heads/main',
  lastMergeSourceCommit: { commitId: api.head },
  creationDate: '2026-11-01T10:00:00Z',
  createdBy: { uniqueName: ME },
  reviewers: [{ uniqueName: 'rev@acme.example', vote: 10 }],
  repository: { name: 'api', project: { name: 'Shop' } },
  ...over,
});
const session = (): WorktreeSession => ({
  target: 'api',
  isGroup: false,
  branch: 'feat/refunds',
  paths: [api.path],
  createdAt: '2026-11-01T00:00:00Z',
  lastAccessedAt: '2026-11-01T00:00:00Z',
});

describe('the adapter, through the same flows as the fake host', () => {
  it("Ship: the branch's PR from Azure DevOps, mergeable; the merge completes it with the head you were shown", async () => {
    az.prs = [prOf()];
    az.policies = [
      { status: 'approved', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'CI' } } },
    ];
    const pre = await shipPreflight(session(), run);
    expect(pre.repos[0]).toMatchObject({
      host: 'azure',
      pr: {
        number: 7,
        state: 'OPEN',
        checks: 'pass',
        mergeStateStatus: 'CLEAN',
        reviewDecision: 'APPROVED',
        baseBranch: 'main',
        url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7',
      },
      mergeBlockers: [],
    });
    const out = await mergeSelected(session(), [{ name: 'api', headSha: api.head }], 'squash', run);
    expect(out.results).toMatchObject([{ repo: 'api', ok: true, merged: true }]);
    expect(az.patched).toEqual([
      {
        status: 'completed',
        lastMergeSourceCommit: { commitId: api.head },
        completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: false },
      },
    ]);
    // argv only: org, project and repository as their own arguments.
    expect(az.calls.find((c) => c.slice(0, 3).join(' ') === 'repos pr list')).toEqual(
      expect.arrayContaining(['--org', ORG, '--project', 'Shop', '--repository', 'api']),
    );
  }, 60_000);

  it('the dashboard list: yours and those asking your vote, each saying Azure DevOps', async () => {
    az.prs = [
      prOf(),
      prOf({ pullRequestId: 8, createdBy: { uniqueName: 'ana@acme.example' }, reviewers: [{ uniqueName: ME, vote: 0 }] }),
      prOf({ pullRequestId: 9, createdBy: { uniqueName: 'ana@acme.example' }, reviewers: [] }),
    ];
    const { map } = await fetchAllPullRequests({ api: api.path }, { run });
    expect(map.get('feat/refunds')?.map((p) => [p.number, p.isMine, p.reviewRequested, p.host])).toEqual([
      [7, true, false, 'azure'],
      [8, false, true, 'azure'],
    ]);
  });

  it("the PR watch: failing builds and an open thread, as a stage and a note in Azure DevOps' words", async () => {
    az.prs = [prOf()];
    az.policies = [
      { status: 'rejected', configuration: { isBlocking: true, type: { displayName: 'Build' }, settings: { displayName: 'unit tests' } } },
    ];
    az.threads = [
      {
        id: 3,
        status: 'active',
        threadContext: { filePath: '/b.txt', rightFileEnd: { line: 1 } },
        comments: [
          {
            id: 1,
            author: { uniqueName: 'rev@acme.example' },
            content: 'Rename this',
            publishedDate: '2026-11-01T11:00:00Z',
            commentType: 'text',
          },
        ],
      },
    ];
    const told: string[] = [];
    const seen = new Set<string>();
    const watch = createPrWatch({
      sessions: () => [{ id: 's1', session: session() }],
      preflight: (s) => shipPreflight(s, run),
      archive: async () => undefined,
      tell: async (_id, body) => void told.push(body),
      broadcast: () => undefined,
      options: () => ({ autoArchive: false, fixCi: true, reviewComments: true }),
      // work web's own wiring (ci-routes.ts): who you are asked of Azure DevOps, not of GitHub.
      ...prWatchHostDeps(run),
      told: () => ({ has: (k) => seen.has(k), add: (k) => void seen.add(k) }),
    });
    const ci = (await watch.refresh('s1')) as SessionCi;
    expect(ci.repos[0]).toMatchObject({ host: 'azure', openThreads: 1 });
    expect(prStageOf(ci.repos)?.kind).toBe('checks_failing');
    const ciNote = told.find((t) => t.startsWith('CI is failing'))!;
    expect(ciNote).toContain('az repos pr policy list');
    expect(told.find((t) => t.startsWith('New review feedback'))).toContain('on Azure DevOps');
    for (const t of told) expect(t).not.toMatch(/\bgh\b|GitHub/);
  }, 60_000);

  it('a rate-limited Azure DevOps keeps what the watch knew', async () => {
    az.limited = true;
    const pre = await shipPreflight(session(), run);
    expect(azure.rateLimited(pre.repos[0].ghError ?? '')).toBe(true);
    az.limited = false;
  }, 60_000);

  it("reply drafts: a thread's reply and resolve go to Azure DevOps; your own last word is refused", async () => {
    const id = azureThreadId({ orgUrl: ORG, project: 'Shop', repo: 'api' }, 7, 3);
    rememberSent('s1', [{ threadId: id, repo: 'api', prNumber: 7, url: 'u', where: 'b.txt:1', reviewer: 'rev', excerpt: 'Rename this' }]);
    az.threads = [{ id: 3, status: 'active', comments: [{ id: 1, author: { uniqueName: ME }, content: 'mine', commentType: 'text' }] }];
    expect(await threadRefusal(id, api.path, run)).toMatch(/already yours/);
    az.threads = [
      {
        id: 3,
        status: 'active',
        comments: [{ id: 1, author: { uniqueName: 'rev@acme.example' }, content: 'Rename this', commentType: 'text' }],
      },
    ];
    az.posted = [];
    const r = await postReply('s1', id, 'Renamed.', { resolve: true, cwd: api.path, run });
    expect(r).toEqual({ ok: true, url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7?discussionId=3', resolved: true });
    expect(az.posted).toEqual([
      { resource: 'pullRequestThreadComments', method: 'POST', body: { content: 'Renamed.', parentCommentId: 1, commentType: 1 } },
      { resource: 'pullRequestThreads', method: 'PATCH', body: { status: 'fixed' } },
    ]);
  });

  it('blocked by an Azure DevOps PR, and Start from its link', async () => {
    const url = 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7';
    expect(blockRefFrom({ kind: 'pr', url })).toEqual({ kind: 'pr', url, label: 'api!7' });
    az.prs = [prOf({ status: 'completed', closedDate: '2026-11-02T09:00:00Z' })];
    expect(await blockedPrState(url, run)).toEqual({ state: 'MERGED' });
    az.prs = [prOf({ createdBy: { uniqueName: 'ana@acme.example' } })];
    const r = await resolvePrToStart(url, { repos: { api: api.path }, groups: {} }, undefined, { run });
    expect(r).toMatchObject({
      ok: true,
      pr: { alias: 'api', number: 7, branch: 'feat/refunds', base: 'main', author: 'ana@acme.example', host: 'azure' },
    });
  });

  it('a review comment is a new thread on the line; open PRs for the review queue; the PR ref is the merge ref', async () => {
    az.posted = [];
    expect(
      await azure.submitReview(run, api.path, 7, {
        commitId: api.head,
        event: 'comment',
        body: '',
        comments: [{ path: 'b.txt', line: 1, body: 'Why two?' }],
      }),
    ).toEqual({ ok: true, url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7' });
    expect(az.posted[0]).toMatchObject({ resource: 'pullRequestThreads', method: 'POST', body: { threadContext: { filePath: '/b.txt' } } });
    az.prs = [prOf({ isDraft: true }), prOf({ pullRequestId: 8, createdBy: { uniqueName: 'ana@acme.example' } })];
    const open = await azure.openPrs(run, api.path);
    expect(open.ok && open.prs.map((p) => [p.number, p.isDraft, p.author])).toEqual([
      [7, true, ME],
      [8, false, 'ana@acme.example'],
    ]);
    expect(azure.prRef(7)).toBe('refs/pull/7/merge');
    expect(azure.prRefIsMerge).toBe(true); // the review reads the head: the merge's second parent
  });
});

describe('#65 review: names, thread ids and az output checked before anything runs', () => {
  it.each([
    ['https://dev.azure.com/acme/Shop/_git/api.git', 'api'],
    ['https://dev.azure.com/acme/Shop/_git/api/', 'api'],
    ['ssh://git@ssh.dev.azure.com/v3/acme/Shop/api', 'api'],
    ['https://dev.azure.com/acme/My%20Shop/_git/api', 'api'],
  ])('reads %s', (origin, repo) => {
    expect(parseAzureOrigin(origin)?.repo).toBe(repo);
  });

  it.each([
    'https://dev.azure.com.evil.example/acme/Shop/_git/api',
    'https://evil.example/dev.azure.com/acme/Shop/_git/api',
    'https://dev.azure.com/ac%22me/Shop/_git/api',
    'https://dev.azure.com/acme/Sh%22op%26echo/_git/api',
    'https://dev.azure.com/acme/Shop/_git/a%25PATH%25',
    'https://dev.azure.com/acme/Shop/_git/a%0Ab',
    'https://-acme.visualstudio.com/Shop/_git/api',
  ])('refuses %s', (origin) => {
    expect(parseAzureOrigin(origin)).toBeNull();
  });

  it("a thread id is only one whose org URL is Azure DevOps' own and whose names it would have", () => {
    const forged = (orgUrl: string, project = 'Shop', repo = 'api') =>
      `AZT_${Buffer.from(JSON.stringify([orgUrl, project, repo])).toString('base64url')}_7_3`;
    for (const id of [
      forged('https://evil.example'),
      forged('http://dev.azure.com/acme'),
      forged('https://dev.azure.com/acme/../x'),
      forged('https://dev.azure.com/acme@evil.example'),
      forged('https://acme.visualstudio.com.evil.example'),
      forged(ORG, 'Shop"&calc&"'),
      forged(ORG, 'Shop', 'a\nb'),
    ]) {
      expect(parseAzureThreadId(id)).toBeNull();
      expect(azure.threads.repoOf?.(id)).toBeNull();
    }
    const good = forged('https://acme.visualstudio.com', 'My Shop', 'api');
    expect(parseAzureThreadId(good)?.repo).toEqual({ orgUrl: 'https://acme.visualstudio.com', project: 'My Shop', repo: 'api' });
    expect(azure.threads.repoOf?.(good)).toBe('acme/my shop/api');
  });

  it('a thread on a repo the session lacks is refused before az is asked anything', async () => {
    const elsewhere = azureThreadId({ orgUrl: ORG, project: 'Shop', repo: 'other' }, 7, 3);
    const repos = [{ name: 'api', path: api.path, github: 'acme/shop/api', host: 'azure', branch: 'feat/refunds' }];
    expect(await liveOpenThread(elsewhere, repos, run)).toEqual({
      error: expect.stringMatching(/is on acme\/shop\/other, not a repo of this session/),
    });
    const forged = `AZT_${Buffer.from(JSON.stringify(['https://evil.example', 'Shop', 'api'])).toString('base64url')}_7_3`;
    expect(await liveOpenThread(forged, repos, run)).toEqual({ error: expect.stringMatching(/not a valid thread id/) });
    expect(az.calls).toEqual([]);

    // On the session's repo: read from Azure DevOps (the thread, the PR), accepted as the watch would list it.
    az.prs = [prOf()];
    az.threads = [
      {
        id: 3,
        status: 'active',
        threadContext: { filePath: '/b.txt', rightFileEnd: { line: 1 } },
        comments: [{ id: 1, author: { uniqueName: 'rev@acme.example' }, content: 'Rename this', commentType: 'text' }],
      },
    ];
    const ours = azureThreadId({ orgUrl: ORG, project: 'Shop', repo: 'api' }, 7, 3);
    expect(await liveOpenThread(ours, repos, run)).toMatchObject({
      reply: { threadId: ours, repo: 'api', prNumber: 7, where: 'b.txt:1', reviewer: 'rev@acme.example', body: 'Rename this' },
    });
    expect(await azure.threads.isResolved(run, api.path, ours)).toBe(false);
    az.threads = [{ id: 3, status: 'fixed', comments: [] }];
    expect(await azure.threads.isResolved(run, api.path, ours)).toBe(true);
    az.failing = { 'devops invoke': 'ERROR: TF401180: not found' };
    expect(await azure.threads.isResolved(run, api.path, ours)).toBeNull(); // can't say: never "resolved"
  });

  it("az's reason: the throttling line wherever it is, else the first line that isn't a WARNING", () => {
    expect(azReason('WARNING: upgrade\nERROR: TF401019: no such repo\nmore')).toBe('ERROR: TF401019: no such repo');
    expect(azReason('WARNING: upgrade\nERROR: failed\nTF400733: The request was blocked')).toBe('TF400733: The request was blocked');
    expect(azReason('WARNING: only this')).toBe('WARNING: only this');
    expect(azReason('')).toBe('');
  });

  it('route values: names Azure DevOps has and numbers, never a path, query or encoding', () => {
    for (const ok of ['Shop', 'My Shop', 'api', 7]) expect(routeValueOk(ok)).toBe(true);
    for (const bad of ['a/b', 'a?b', 'a#b', 'a%2Fb', 'a=b', 'a&b', 'a\nb', ' a', '', -1, 1.5]) expect(routeValueOk(bad)).toBe(false);
  });
});

describe('#65 review: what az answers, and what it fails to', () => {
  it.each([
    ['conflicts', 'DIRTY'],
    ['failure', 'BLOCKED'],
    ['rejectedByPolicy', 'BLOCKED'],
    ['queued', 'UNKNOWN'],
    ['notSet', 'UNKNOWN'],
    ['succeeded', 'CLEAN'],
    [undefined, 'CLEAN'],
  ])('mergeStatus %s is %s', (mergeStatus, state) => {
    expect(mergeState({ mergeStatus }, [])).toBe(state);
  });

  it.each([
    [[{ status: 'broken', configuration: { type: { displayName: 'Build' } } }], 'fail'],
    [[{ status: 'queued', configuration: { type: { displayName: 'Build' } } }], 'pending'],
    [[{ status: 'notApplicable', configuration: { type: { displayName: 'Build' } } }], 'none'],
    [[{ status: 'rejected', configuration: { isEnabled: false, type: { displayName: 'Build' } } }], 'none'],
    [[{ status: 'rejected', configuration: { type: { displayName: 'Comment requirements' } } }], 'none'],
  ])('policies %j are checks %s', (policies, checks) => {
    expect(checksOf(policies).checks).toBe(checks);
  });

  it("a failed policy lookup is an error, never a clean PR with no checks (and throttling there is the watch's to see)", async () => {
    az.prs = [prOf()];
    az.failing = { 'repos pr policy list': 'WARNING: x\nTF400733: The request was blocked' };
    const found = await azure.prForBranch(run, api.path, 'feat/refunds');
    expect(found).toEqual({ kind: 'error', error: 'TF400733: The request was blocked' });
    expect(azure.rateLimited(found.kind === 'error' ? found.error : '')).toBe(true);
    // A closed PR has no policies to ask.
    az.prs = [prOf({ status: 'completed', closedDate: '2026-11-02T09:00:00Z' })];
    expect(await azure.prForBranch(run, api.path, 'feat/refunds')).toMatchObject({
      kind: 'pr',
      pr: { state: 'MERGED', updatedAt: '2026-11-02T09:00:00Z' },
    });
  });

  it('an open PR has no updatedAt (its creationDate never moves): the watch reads its threads every check', async () => {
    az.prs = [prOf()];
    const found = await azure.prForBranch(run, api.path, 'feat/refunds');
    expect(found.kind === 'pr' && 'updatedAt' in found.pr).toBe(false);
  });

  it('who you are unknown: the repo is incomplete, its PRs never dropped as "not yours"', async () => {
    az.prs = [prOf()];
    az.failing = { 'account show': "ERROR: Please run 'az login' to setup account." };
    expect(await azure.list([{ alias: 'api', path: api.path, origin: ORIGIN }], run)).toEqual({ prs: [], incomplete: ['api'] });
  });

  it("az missing, or an answer that isn't JSON, is an error", async () => {
    const missing: CommandRunner = async (cmd, args, cwd) => (cmd === 'az' ? { code: 127, stdout: '', stderr: '' } : run(cmd, args, cwd));
    expect(await azure.prForBranch(missing, api.path, 'feat/refunds')).toEqual({
      kind: 'error',
      error: expect.stringMatching(/Azure CLI \(az\) not found/),
    });
    const garbled: CommandRunner = async (cmd, args, cwd) =>
      cmd === 'az' ? { code: 0, stdout: '<html>', stderr: '' } : run(cmd, args, cwd);
    expect(await azure.prForBranch(garbled, api.path, 'feat/refunds')).toEqual({ kind: 'error', error: "couldn't read what az said" });
    expect(await azure.mergedPr(garbled, api.path, 'feat/refunds', api.head)).toBeUndefined();
  });

  it('Start from #N: the PR must be in this repo — Azure DevOps numbers PRs per organisation', async () => {
    az.prs = [prOf()];
    expect(await azure.prByNumber(run, api.path, 'acme/shop/api', 7)).toMatchObject({
      ok: true,
      pr: { number: 7, branch: 'feat/refunds' },
    });
    az.prs = [prOf({ repository: { name: 'web', project: { name: 'Shop' } } })];
    expect(await azure.prByNumber(run, api.path, 'acme/shop/api', 7)).toEqual({ ok: false, error: 'PR #7 is in Shop/web, not Shop/api' });
    expect(await azure.prByNumber(run, api.path, 'acme/shop/web', 7)).toEqual({ ok: false, error: "PR #7: its repo isn't this folder's" });
  });

  it('createPr goes through the REST API: title and description in a file, into the default branch, draft as asked', async () => {
    const made = await azure.createPr(run, api.path, 'feat/refunds', { draft: true });
    expect(made).toEqual({ ok: true, url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/12' });
    expect(az.posted).toEqual([
      {
        resource: 'pullRequests',
        method: 'POST',
        body: {
          sourceRefName: 'refs/heads/feat/refunds',
          targetRefName: 'refs/heads/main',
          title: 'Add refunds',
          description: '',
          isDraft: true,
        },
      },
    ]);
    // Nothing of the commit's text is on argv.
    expect(az.calls.flat().some((a) => a.includes('Add refunds'))).toBe(false);
  });

  it('mergedPr: the completed PR whose head is the tip; none; undefined when az fails', async () => {
    az.prs = [prOf({ status: 'completed' })];
    expect(await azure.mergedPr(run, api.path, 'feat/refunds', api.head)).toBe(7);
    expect(await azure.mergedPr(run, api.path, 'feat/refunds', 'other')).toBeNull();
    az.failing = { 'repos pr list': 'ERROR: boom' };
    expect(await azure.mergedPr(run, api.path, 'feat/refunds', api.head)).toBeUndefined();
  });

  it("a merge is a merge only when Azure DevOps says completed; each method is Azure's strategy", async () => {
    az.completeAs = 'active';
    expect(await azure.mergePr(run, api.path, 7, 'merge', api.head)).toEqual({
      ok: false,
      error: "Azure DevOps didn't complete PR #7, it is active (merge: queued): its completion may be queued until its policies pass",
    });
    az.completeAs = 'completed';
    expect(await azure.mergePr(run, api.path, 7, 'rebase', api.head)).toEqual({ ok: true });
    expect(az.patched.map((p) => (p as { completionOptions: { mergeStrategy: string } }).completionOptions.mergeStrategy)).toEqual([
      'noFastForward',
      'rebase',
    ]);
    az.failing = { 'devops invoke': 'ERROR: TF401192: the PR was updated' };
    expect(await azure.mergePr(run, api.path, 7, 'squash', 'stale')).toEqual({ ok: false, error: 'ERROR: TF401192: the PR was updated' });
  });

  it('the PR watch, twice: no threads at first, then one — the second check sees it (an open PR is never "unchanged")', async () => {
    az.prs = [prOf()];
    const seen = new Set<string>();
    const told: string[] = [];
    const watch = createPrWatch({
      sessions: () => [{ id: 's2', session: session() }],
      preflight: (s) => shipPreflight(s, run),
      archive: async () => undefined,
      tell: async (_id, body) => void told.push(body),
      broadcast: () => undefined,
      options: () => ({ autoArchive: false, fixCi: false, reviewComments: true }),
      ...prWatchHostDeps(run),
      told: () => ({ has: (k) => seen.has(k), add: (k) => void seen.add(k) }),
    });
    expect((await watch.refresh('s2'))?.repos[0].openThreads).toBe(0);
    az.threads = [
      {
        id: 4,
        status: 'active',
        comments: [
          {
            id: 1,
            author: { uniqueName: 'rev@acme.example' },
            content: 'Why?',
            publishedDate: '2026-11-03T08:00:00Z',
            commentType: 'text',
          },
        ],
      },
    ];
    expect((await watch.refresh('s2'))?.repos[0].openThreads).toBe(1);
    expect(told.some((t) => t.includes('Why?'))).toBe(true);
  }, 60_000);

  it("watchAskGh: a resting host's repos never; else a pushed branch, or one whose PR the watch knows", () => {
    const ask = watchAskGh(
      (h) => h === 'azure',
      (name) => name === 'known',
    );
    const r = (over: Partial<Parameters<typeof ask>[0]>) => ({ name: 'x', hasUpstream: true, commitsVsBase: 1, ...over });
    expect(ask(r({ host: 'azure' }))).toBe(false);
    expect(ask(r({}))).toBe(true);
    expect(ask(r({ hasUpstream: false }))).toBe(false);
    expect(ask(r({ hasUpstream: false, name: 'known' }))).toBe(true);
    expect(watchAskGh(undefined, () => false)(r({ host: 'azure' }))).toBe(true);
  });

  it('a throttled Azure DevOps: the watch keeps what it knew and asks it nothing until it rests', async () => {
    az.prs = [prOf()];
    let t = Date.parse('2026-11-03T10:00:00Z');
    const watch = createPrWatch({
      sessions: () => [{ id: 's3', session: session() }],
      // work web's own wiring (ci-routes.ts): a resting host's repos aren't asked.
      preflight: (s, o) => shipPreflight(s, run, { askGh: watchAskGh(o?.resting, () => false) }),
      archive: async () => undefined,
      tell: async () => undefined,
      broadcast: () => undefined,
      options: () => ({ autoArchive: false, fixCi: false, reviewComments: true }),
      ...prWatchHostDeps(run),
      told: () => ({ has: () => false, add: () => undefined }),
      now: () => t,
    });
    await watch.tick();
    expect(watch.state('s3')?.repos[0].pr?.number).toBe(7);
    az.limited = true;
    await watch.tick();
    expect(watch.state('s3')?.repos[0].pr?.number).toBe(7); // not "no PR"
    const calls = az.calls.length;
    t += 60_000;
    await watch.tick();
    expect(az.calls.length).toBe(calls); // resting: az not asked
    az.limited = false;
    t += 10 * 60_000;
    await watch.tick();
    expect(az.calls.length).toBeGreaterThan(calls);
  }, 60_000);
});
