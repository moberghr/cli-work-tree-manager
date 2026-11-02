import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandRunner } from '../../platform/command-runner.js';
import { originUrl, readGitConfig } from '../../worktree/repo-scan.js';
import type { GitHost, HostResult } from '../types.js';
import type { PullRequestInfo } from '../../pr/pr-types.js';
import { azureCommands } from './commands.js';
import { AZURE_THREAD_ID, azureRepoId, onAzure, parseAzureOrigin, parseAzurePrUrl, parseAzureThreadId, type AzureRepo } from './origin.js';
import {
  feedbackOf,
  openPrOf,
  pickPr,
  prForStartOf,
  prInfoOf,
  prState,
  prWebUrl,
  RESOLVED_THREAD,
  shipPrOf,
  type AzPolicy,
  type AzPr,
  type AzThread,
} from './map.js';

/**
 * Azure DevOps, through the `az` CLI with the azure-devops extension and the
 * user's own `az login` (#65). Argv only, never a shell string. Nothing is
 * stored: no token in config. What `az repos` has no command for (threads,
 * their comments, a merge that checks the head) goes through
 * `az devops invoke`, Azure DevOps' REST API as the signed-in user.
 */

const API = '7.1';
const oneLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** `az … --output json`, parsed; an error with its first line when az fails or says something that isn't JSON. */
async function az<T>(run: CommandRunner, cwd: string, args: string[]): Promise<HostResult<{ value: T }>> {
  const r = await run('az', [...args, '--output', 'json'], cwd);
  if (r.code === 127) return { ok: false, error: 'Azure CLI (az) not found — install it and the azure-devops extension' };
  if (r.code !== 0) return { ok: false, error: oneLine(r.stderr) || `az ${args.slice(0, 3).join(' ')} failed` };
  try {
    return { ok: true, value: JSON.parse(r.stdout || 'null') as T };
  } catch {
    return { ok: false, error: "couldn't read what az said" };
  }
}

/** The repo at `cwd`, from its origin; null when it isn't on Azure DevOps. */
function repoAt(cwd: string): AzureRepo | null {
  const text = readGitConfig(cwd);
  const origin = text ? originUrl(text) : null;
  return origin ? parseAzureOrigin(origin) : null;
}

const where = (r: AzureRepo) => ['--org', r.orgUrl, '--project', r.project, '--repository', r.repo];

/** A REST call through `az devops invoke` (a body goes through a temp file: argv only). */
async function invoke<T>(
  run: CommandRunner,
  cwd: string,
  r: Pick<AzureRepo, 'orgUrl' | 'project' | 'repo'>,
  resource: string,
  route: Record<string, string | number>,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown,
): Promise<HostResult<{ value: T }>> {
  const params = Object.entries({ project: r.project, repositoryId: r.repo, ...route }).map(([k, v]) => `${k}=${v}`);
  let dir: string | null = null;
  const args = [
    'devops',
    'invoke',
    '--org',
    r.orgUrl,
    '--area',
    'git',
    '--resource',
    resource,
    '--route-parameters',
    ...params,
    '--http-method',
    method,
    '--api-version',
    API,
  ];
  try {
    if (body !== undefined) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-az-'));
      const file = path.join(dir, 'body.json');
      fs.writeFileSync(file, JSON.stringify(body));
      args.push('--in-file', file);
    }
    return await az<T>(run, cwd, args);
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Who `az` is signed in as (its user name: the e-mail Azure DevOps names people by). */
async function viewer(run: CommandRunner, cwd: string): Promise<string | null> {
  const r = await az<{ user?: { name?: string } }>(run, cwd, ['account', 'show']);
  return r.ok && r.value?.user?.name ? r.value.user.name : null;
}

async function policies(run: CommandRunner, cwd: string, r: AzureRepo, id: number): Promise<AzPolicy[]> {
  const p = await az<AzPolicy[]>(run, cwd, ['repos', 'pr', 'policy', 'list', '--id', String(id), '--org', r.orgUrl]);
  return p.ok && Array.isArray(p.value) ? p.value : [];
}

const MERGE_STRATEGY = { squash: 'squash', merge: 'noFastForward', rebase: 'rebase' } as const;

export const azure: GitHost = {
  id: 'azure',
  name: 'Azure DevOps',
  cli: {
    cmd: 'az',
    label: 'Azure CLI (azure-devops)',
    checkArgs: ['account', 'show'],
    missing:
      'Optional: install the Azure CLI and its azure-devops extension (az extension add --name azure-devops) to see the pull requests of your Azure DevOps repos.',
    failing: 'Optional: run `az login` so work can see your Azure DevOps pull requests.',
  },
  matches: onAzure,
  repoId: azureRepoId,
  parsePrUrl: (t) => {
    const l = parseAzurePrUrl(t);
    return l ? { repoId: l.repoId, number: l.number, url: l.url, label: l.label } : null;
  },
  // The PR merged into its target (its first parent): the diff from their merge-base is the PR's change.
  prRef: (n) => `refs/pull/${n}/merge`,

  async list(repos, run) {
    const prs: PullRequestInfo[] = [];
    const incomplete: string[] = [];
    let me: string | null | undefined;
    for (const repo of repos) {
      const r = repo.origin ? parseAzureOrigin(repo.origin) : null;
      if (!r) {
        incomplete.push(repo.alias);
        continue;
      }
      me ??= await viewer(run, repo.path);
      const list = await az<AzPr[]>(run, repo.path, ['repos', 'pr', 'list', ...where(r), '--status', 'active', '--top', '100']);
      if (!list.ok || !Array.isArray(list.value)) {
        incomplete.push(repo.alias);
        continue;
      }
      for (const pr of list.value) {
        const row = prInfoOf(r, repo.alias, pr, me ?? '');
        // The dashboard lists yours and those asking you (as on GitHub).
        if (row && (row.isMine || row.reviewRequested)) prs.push(row);
      }
      if (list.value.length >= 100) incomplete.push(repo.alias);
    }
    return { prs, incomplete };
  },
  viewer,

  async prForBranch(run, cwd, branch) {
    const r = repoAt(cwd);
    if (!r) return { kind: 'error', error: "this repo's origin isn't an Azure DevOps one" };
    const list = await az<AzPr[]>(run, cwd, [
      'repos',
      'pr',
      'list',
      ...where(r),
      '--source-branch',
      branch,
      '--status',
      'all',
      '--top',
      '10',
    ]);
    if (!list.ok) return { kind: 'error', error: list.error };
    const pr = pickPr(Array.isArray(list.value) ? list.value : []);
    if (!pr) return { kind: 'none' };
    const pol = pr.status === 'active' ? await policies(run, cwd, r, pr.pullRequestId!) : [];
    const ship = shipPrOf(r, pr, pol);
    return ship ? { kind: 'pr', pr: ship } : { kind: 'error', error: "couldn't read what az said about the PR" };
  },

  async prByNumber(run, cwd, repoId, number) {
    const r = repoAt(cwd);
    if (!r || `${r.org}/${r.project}/${r.repo}`.toLowerCase() !== repoId)
      return { ok: false, error: `PR #${number}: its repo isn't this folder's` };
    const shown = await az<AzPr>(run, cwd, ['repos', 'pr', 'show', '--id', String(number), '--org', r.orgUrl]);
    if (!shown.ok) return { ok: false, error: `PR #${number} in ${r.repo}: ${shown.error}` };
    const pr = prForStartOf(r, shown.value ?? {});
    return pr ? { ok: true, pr } : { ok: false, error: "couldn't read what az said about the PR" };
  },

  async prState(run, url) {
    const l = parseAzurePrUrl(url);
    if (!l) return { ok: false, error: 'not an Azure DevOps pull request link' };
    const shown = await az<AzPr>(run, os.tmpdir(), ['repos', 'pr', 'show', '--id', String(l.number), '--org', l.repo.orgUrl]);
    return shown.ok ? { ok: true, state: prState(shown.value?.status) } : { ok: false, error: shown.error };
  },

  async createPr(run, cwd, branch, opts) {
    const r = repoAt(cwd);
    if (!r) return { ok: false, error: "this repo's origin isn't an Azure DevOps one" };
    // `--fill` as gh does it: the last commit's subject and body.
    const subject = (await run('git', ['log', '-1', '--format=%s'], cwd)).stdout.trim() || branch;
    const body = (await run('git', ['log', '-1', '--format=%b'], cwd)).stdout.trim();
    const args = ['repos', 'pr', 'create', ...where(r), '--source-branch', branch, '--title', subject];
    if (body) args.push('--description', body);
    if (opts.draft) args.push('--draft', 'true');
    const made = await az<AzPr>(run, cwd, args);
    if (!made.ok) return { ok: false, error: made.error };
    const n = made.value?.pullRequestId;
    return { ok: true, ...(typeof n === 'number' ? { url: prWebUrl(r, n) } : {}) };
  },

  async mergePr(run, cwd, number, method, headSha) {
    const r = repoAt(cwd);
    if (!r) return { ok: false, error: "this repo's origin isn't an Azure DevOps one" };
    // Completing with lastMergeSourceCommit: Azure DevOps refuses when the PR moved past the commit you were shown.
    const done = await invoke<AzPr>(run, cwd, r, 'pullRequests', { pullRequestId: number }, 'PATCH', {
      status: 'completed',
      lastMergeSourceCommit: { commitId: headSha },
      completionOptions: { mergeStrategy: MERGE_STRATEGY[method], deleteSourceBranch: false },
    });
    return done.ok ? { ok: true } : { ok: false, error: done.error };
  },

  async mergedPr(run, cwd, branch, tip) {
    const r = repoAt(cwd);
    if (!r) return undefined;
    const list = await az<AzPr[]>(run, cwd, [
      'repos',
      'pr',
      'list',
      ...where(r),
      '--source-branch',
      branch,
      '--status',
      'completed',
      '--top',
      '10',
    ]);
    if (!list.ok || !Array.isArray(list.value)) return undefined;
    return list.value.find((p) => p.lastMergeSourceCommit?.commitId === tip)?.pullRequestId ?? null;
  },

  async openPrs(run, cwd) {
    const r = repoAt(cwd);
    if (!r) return { ok: false, error: "this repo's origin isn't an Azure DevOps one" };
    const list = await az<AzPr[]>(run, cwd, ['repos', 'pr', 'list', ...where(r), '--status', 'active', '--top', '50']);
    if (!list.ok) return { ok: false, error: list.error };
    return { ok: true, prs: (Array.isArray(list.value) ? list.value : []).flatMap((p) => openPrOf(r, p) ?? []) };
  },

  async postReviewComment(run, cwd, number, c) {
    const r = repoAt(cwd);
    if (!r) return { ok: false, error: "this repo's origin isn't an Azure DevOps one" };
    const made = await invoke<AzThread>(run, cwd, r, 'pullRequestThreads', { pullRequestId: number }, 'POST', {
      comments: [{ parentCommentId: 0, content: c.body, commentType: 1 }],
      status: 'active',
      threadContext: { filePath: `/${c.path}`, rightFileStart: { line: c.line, offset: 1 }, rightFileEnd: { line: c.line, offset: 1 } },
    });
    if (!made.ok) return { ok: false, error: made.error };
    const id = made.value?.id;
    return { ok: true, ...(typeof id === 'number' ? { url: `${prWebUrl(r, number)}?discussionId=${id}` } : {}) };
  },

  async reviewFeedback(run, cwd, number) {
    const r = repoAt(cwd);
    if (!r) return null;
    const me = await viewer(run, cwd);
    // Who you are tells your words from a reviewer's: without it the lookup failed (callers keep the last count).
    if (!me) return null;
    const threads = await invoke<{ value?: AzThread[] }>(run, cwd, r, 'pullRequestThreads', { pullRequestId: number });
    if (!threads.ok) return null;
    return feedbackOf(r, number, threads.value?.value ?? [], me);
  },

  threads: {
    isId: (id) => AZURE_THREAD_ID.test(id),
    async now(run, cwd, id) {
      const t = parseAzureThreadId(id);
      if (!t) return { ok: false, error: 'not an Azure DevOps thread id' };
      const me = await viewer(run, cwd);
      const got = await invoke<AzThread>(run, cwd, t.repo, 'pullRequestThreads', { pullRequestId: t.pr, threadId: t.thread });
      if (!me || !got.ok || !got.value)
        return { ok: false, error: `couldn't read the thread on Azure DevOps first${got.ok ? '' : `: ${got.error}`}` };
      const people = (got.value.comments ?? []).filter((c) => c && !c.isDeleted && c.commentType !== 'system');
      return {
        ok: true,
        thread: {
          viewer: me,
          resolved: RESOLVED_THREAD.has(got.value.status ?? ''),
          lastAuthor: people.at(-1)?.author?.uniqueName ?? null,
        },
      };
    },
    async live(run, cwd, id) {
      const t = parseAzureThreadId(id);
      if (!t) return { ok: false, error: 'not an Azure DevOps thread id' };
      const me = await viewer(run, cwd);
      const got = await invoke<AzThread>(run, cwd, t.repo, 'pullRequestThreads', { pullRequestId: t.pr, threadId: t.thread });
      const pr = await az<AzPr>(run, cwd, ['repos', 'pr', 'show', '--id', String(t.pr), '--org', t.repo.orgUrl]);
      if (!me || !got.ok || !got.value || !pr.ok) return { ok: false, error: `${id} isn't a review thread Azure DevOps knows` };
      const people = (got.value.comments ?? []).filter((c) => c && !c.isDeleted && c.commentType !== 'system');
      const first = people[0];
      const last = people.at(-1);
      const url = `${prWebUrl(t.repo, t.pr)}?discussionId=${t.thread}`;
      const ctx = got.value.threadContext;
      const repo = parseAzureOrigin(`${t.repo.orgUrl}/${encodeURIComponent(t.repo.project)}/_git/${encodeURIComponent(t.repo.repo)}`);
      return {
        ok: true,
        thread: {
          viewer: me,
          resolved: RESOLVED_THREAD.has(got.value.status ?? ''),
          outdated: false,
          path: ctx?.filePath ? ctx.filePath.replace(/^\//, '') : null,
          line: ctx?.rightFileEnd?.line ?? null,
          originalStartLine: null,
          originalLine: null,
          first: first ? { author: first.author?.uniqueName ?? '', body: first.content ?? '', url, diffHunk: null } : null,
          last: last ? { author: last.author?.uniqueName ?? '', url } : null,
          pr: {
            number: t.pr,
            url: prWebUrl(t.repo, t.pr),
            headBranch: (pr.value?.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
            repoId: repo ? `${repo.org}/${repo.project}/${repo.repo}`.toLowerCase() : '',
          },
        },
      };
    },
    async isResolved(run, cwd, id) {
      const t = parseAzureThreadId(id);
      if (!t) return null;
      const got = await invoke<AzThread>(run, cwd, t.repo, 'pullRequestThreads', { pullRequestId: t.pr, threadId: t.thread });
      return got.ok && got.value?.status ? RESOLVED_THREAD.has(got.value.status) : null;
    },
    async reply(run, cwd, id, body) {
      const t = parseAzureThreadId(id);
      if (!t) return { ok: false, error: 'not an Azure DevOps thread id' };
      const made = await invoke(run, cwd, t.repo, 'pullRequestThreadComments', { pullRequestId: t.pr, threadId: t.thread }, 'POST', {
        content: body,
        parentCommentId: 1,
        commentType: 1,
      });
      return made.ok ? { ok: true, url: `${prWebUrl(t.repo, t.pr)}?discussionId=${t.thread}` } : { ok: false, error: made.error };
    },
    async resolve(run, cwd, id) {
      const t = parseAzureThreadId(id);
      if (!t) return false;
      const done = await invoke(run, cwd, t.repo, 'pullRequestThreads', { pullRequestId: t.pr, threadId: t.thread }, 'PATCH', {
        status: 'fixed',
      });
      return done.ok;
    },
  },

  // Azure DevOps throttling: TF400733 ("request was blocked"), or HTTP 429.
  rateLimited: (text) => /TF400733|\b429\b|Too Many Requests|rate limit/i.test(text),
  // A completed PR's merge commit is the user's own (Azure DevOps commits as the person completing it).
  hostCommit: () => false,
  commands: azureCommands,
};
