import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { azure } from '../../../src/core/hosts/azure/adapter.js';
import { azureRepoId, azureThreadId, parseAzureOrigin, parseAzurePrUrl, parseAzureThreadId } from '../../../src/core/hosts/azure/origin.js';
import { checksOf, feedbackOf, mergeState, reviewDecision, type AzPr } from '../../../src/core/hosts/azure/map.js';
import { hostForOrigin, hostOfPrUrl, hostOfThread } from '../../../src/core/hosts/index.js';
import { parsePrLink, threadHostId } from '../../../src/core/hosts/links.js';
import { commandsFor } from '../../../src/core/hosts/commands.js';
import { defaultRunner, type CommandRunner, type RunResult } from '../../../src/core/platform/command-runner.js';
import { mergeSelected, shipPreflight } from '../../../src/core/pr/ship.js';
import { fetchAllPullRequests } from '../../../src/core/pr/pr.js';
import { createPrWatch } from '../../../src/core/pr/pr-watch.js';
import { prWatchHostDeps } from '../../../src/core/pr/pr-watch-hosts.js';
import { prStageOf } from '../../../src/core/pr/pr-stage.js';
import { postReply, rememberSent, threadRefusal } from '../../../src/core/pr/pr-replies.js';
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
  patched: unknown[];
  posted: unknown[];
  limited: boolean;
  calls: string[][];
}
const az: AzState = { prs: [], policies: [], threads: [], patched: [], posted: [], limited: false, calls: [] };

/** git through, az from the fixtures (bodies read from the --in-file before it's deleted). */
const run: CommandRunner = async (cmd, args, cwd): Promise<RunResult> => {
  if (cmd !== 'az') return defaultRunner(cmd, args, cwd);
  az.calls.push(args);
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
  if (az.limited) return { code: 1, stdout: '', stderr: 'TF400733: The request was blocked' };
  const a = args.join(' ');
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
      return ok({ pullRequestId: 7, status: 'completed' });
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
    expect(await azure.postReviewComment(run, api.path, 7, { path: 'b.txt', line: 1, body: 'Why two?', commitId: api.head })).toEqual({
      ok: true,
      url: 'https://dev.azure.com/acme/Shop/_git/api/pullrequest/7?discussionId=99',
    });
    expect(az.posted[0]).toMatchObject({ resource: 'pullRequestThreads', method: 'POST', body: { threadContext: { filePath: '/b.txt' } } });
    az.prs = [prOf({ isDraft: true }), prOf({ pullRequestId: 8, createdBy: { uniqueName: 'ana@acme.example' } })];
    const open = await azure.openPrs(run, api.path);
    expect(open.ok && open.prs.map((p) => [p.number, p.isDraft, p.author])).toEqual([
      [7, true, ME],
      [8, false, 'ana@acme.example'],
    ]);
    expect(azure.prRef(7)).toBe('refs/pull/7/merge');
  });
});
