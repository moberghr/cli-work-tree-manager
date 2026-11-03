import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUN_TIMED_OUT, type CommandRunner } from '../../platform/command-runner.js';
import { originUrl, readGitConfig } from '../../worktree/repo-scan.js';
import type { GitHost, SubmitReviewResult } from '../types.js';
import { refusedClearly } from '../submit-doubt.js';
import type { PullRequestInfo } from '../../pr/pr-types.js';
import { azureCommands } from './commands.js';
import {
  AZURE_THREAD_ID,
  azureRepoId,
  azureThreadRepoId,
  onAzure,
  parseAzureOrigin,
  parseAzurePrUrl,
  parseAzureThreadId,
  type AzureRepo,
} from './origin.js';
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
  type AzIteration,
  type AzThread,
} from './map.js';

const lower = (s: string | undefined | null) => (s ?? '').toLowerCase();

/**
 * Azure DevOps, through the `az` CLI with the azure-devops extension and the
 * user's own `az login` (#65). Argv only, never a shell string. Nothing is
 * stored: no token in config. What `az repos` has no command for (threads,
 * their comments, a merge that checks the head) goes through
 * `az devops invoke`, Azure DevOps' REST API as the signed-in user.
 */

const API = '7.1';

/** Azure DevOps' words for "slow down": TF400733 ("request was blocked"), or HTTP 429. */
const THROTTLED = /TF400733|\b429\b|Too Many Requests|rate limit/i;

/**
 * The line of az's error output that says why: the throttling one wherever it is (the PR watch rests on it), else
 * the first that isn't one of az's WARNING lines (an extension or upgrade notice comes first), else the first.
 */
export function azReason(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => THROTTLED.test(l)) ?? lines.find((l) => !/^WARNING:/i.test(l)) ?? lines[0] ?? '';
}

/**
 * What az said: its value, or why not. `uncertain`: no clear refusal — it timed out, a server error, a dropped
 * connection, or it exited 0 with an answer that couldn't be read — so what it was asked may have happened (a
 * write's caller holds it in doubt; a read's ignores it).
 */
type AzResult<T> = { ok: true; value: T } | { ok: false; error: string; uncertain?: boolean };

/**
 * Azure DevOps' own words for a request it refused, beyond a 4xx status: not signed in, no permission (TF400813,
 * TF401027/8, VS403xxx), no such repository (TF401019), a PR that can't be changed (TF401181), a policy that refused it.
 */
const AZ_REFUSAL = /az login|az devops login|Before you can run Azure DevOps commands|TF400813|TF40102[78]|TF401019|TF401181|VS403\d{3}/i;

/** `az … --output json`, parsed; an error with its first line when az fails or says something that isn't JSON. */
async function az<T>(run: CommandRunner, cwd: string, args: string[]): Promise<AzResult<T>> {
  const r = await run('az', [...args, '--output', 'json'], cwd);
  if (r.code === 127) return { ok: false, error: 'Azure CLI (az) not found — install it and the azure-devops extension' };
  if (r.code === RUN_TIMED_OUT) return { ok: false, error: azReason(r.stderr) || 'az timed out', uncertain: true };
  if (r.code !== 0)
    return {
      ok: false,
      error: azReason(r.stderr) || `az ${args.slice(0, 3).join(' ')} failed`,
      ...(refusedClearly(r.code, r.stderr, AZ_REFUSAL) ? {} : { uncertain: true }),
    };
  try {
    return { ok: true, value: JSON.parse(r.stdout || 'null') as T };
  } catch {
    // It said it did it, in words that couldn't be read: a write may well have happened.
    return { ok: false, error: "couldn't read what az said", uncertain: true };
  }
}

/** The repo at `cwd`, from its origin; null when it isn't on Azure DevOps. */
function repoAt(cwd: string): AzureRepo | null {
  const text = readGitConfig(cwd);
  const origin = text ? originUrl(text) : null;
  return origin ? parseAzureOrigin(origin) : null;
}

const where = (r: AzureRepo) => ['--org', r.orgUrl, '--project', r.project, '--repository', r.repo];

/**
 * A route parameter's value as `az devops invoke` takes it (`name=value`, put into the URL's path): only names
 * Azure DevOps allows and numbers, never `/ ? # % = &` or a control character — refused rather than relying on
 * how az encodes it.
 */
export const routeValueOk = (v: string | number): boolean =>
  typeof v === 'number' ? Number.isSafeInteger(v) && v >= 0 : /^[^/\\?#%=&\x00-\x1f\x7f]{1,128}$/.test(v) && v.trim() === v;

/** A REST call through `az devops invoke` (a body goes through a temp file: argv only, free text never on it). */
async function invoke<T>(
  run: CommandRunner,
  cwd: string,
  r: Pick<AzureRepo, 'orgUrl' | 'project' | 'repo'>,
  resource: string,
  route: Record<string, string | number>,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown,
): Promise<AzResult<T>> {
  const values = Object.entries({ project: r.project, repositoryId: r.repo, ...route });
  const bad = values.find(([, v]) => !routeValueOk(v));
  if (bad) return { ok: false, error: `refused: ${bad[0]} isn't a name Azure DevOps has` };
  const params = values.map(([k, v]) => `${k}=${v}`);
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
    // Tidying the temp folder never turns a call that went through into a failure (a retry would send it again).
    if (dir)
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp file; the OS clears its temp folder */
      }
  }
}

/** Who `az` is signed in as (its user name: the e-mail Azure DevOps names people by). */
async function viewer(run: CommandRunner, cwd: string): Promise<string | null> {
  const r = await az<{ user?: { name?: string } }>(run, cwd, ['account', 'show']);
  return r.ok && r.value?.user?.name ? r.value.user.name : null;
}

/** A PR's policy evaluations; an error when az can't say — never "no policies", which would read as clean. */
async function policies(run: CommandRunner, cwd: string, r: AzureRepo, id: number): Promise<AzResult<AzPolicy[]>> {
  const p = await az<AzPolicy[]>(run, cwd, ['repos', 'pr', 'policy', 'list', '--id', String(id), '--org', r.orgUrl]);
  if (!p.ok) return p;
  return Array.isArray(p.value) ? { ok: true, value: p.value } : { ok: false, error: "couldn't read what az said about the PR's policies" };
}

/** The PR's iteration (push) whose source commit is `commitId`: where a review comment is anchored. */
async function iterationAt(run: CommandRunner, cwd: string, r: AzureRepo, number: number, commitId: string): Promise<AzResult<number>> {
  const got = await invoke<{ value?: AzIteration[] }>(run, cwd, r, 'pullRequestIterations', { pullRequestId: number });
  if (!got.ok) return got;
  const its = (got.value?.value ?? []).filter((i) => typeof i?.id === 'number' && i.sourceRefCommit?.commitId === commitId);
  const id = its.at(-1)?.id;
  return typeof id === 'number'
    ? { ok: true, value: id }
    : { ok: false, error: `the PR has no push at ${commitId.slice(0, 8)} (it moved since the review was prepared)` };
}

/** How many open PRs one listing asks for; a list that long may have stopped short (`more`). */
const OPEN_PR_LIMIT = 100;

/** A review comment: a new thread on a line of the PR's new side. */
async function postThread(
  run: CommandRunner,
  cwd: string,
  r: AzureRepo,
  number: number,
  c: { path: string; line: number; body: string },
  iteration: number,
): Promise<AzResult<AzThread>> {
  return invoke<AzThread>(run, cwd, r, 'pullRequestThreads', { pullRequestId: number }, 'POST', {
    comments: [{ parentCommentId: 0, content: c.body, commentType: 1 }],
    status: 'active',
    threadContext: { filePath: `/${c.path}`, rightFileStart: { line: c.line, offset: 1 }, rightFileEnd: { line: c.line, offset: 1 } },
    // At the push the review read (its lines are that commit's), not whatever the PR is at now.
    pullRequestThreadContext: { iterationContext: { firstComparingIteration: iteration, secondComparingIteration: iteration } },
  });
}

const MERGE_STRATEGY = { squash: 'squash', merge: 'noFastForward', rebase: 'rebase' } as const;

export const azure: GitHost = {
  id: 'azure',
  name: 'Azure DevOps',
  cli: {
    cmd: 'az',
    label: 'Azure CLI (azure-devops)',
    checkArgs: ['account', 'show'],
    requires: [
      {
        args: ['extension', 'show', '--name', 'azure-devops'],
        failing:
          "Optional: add the Azure CLI's azure-devops extension (az extension add --name azure-devops) to see the pull requests of your Azure DevOps repos.",
      },
    ],
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
  // The PR merged into its target (its first parent); its second parent is the PR's head, where a review reads and comments.
  prRef: (n) => `refs/pull/${n}/merge`,
  prRefIsMerge: true,

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
      // Who you are unknown: yours and those asking you can't be told apart, so the repo's list is incomplete, never empty.
      if (!me) {
        me = undefined;
        incomplete.push(repo.alias);
        continue;
      }
      const list = await az<AzPr[]>(run, repo.path, ['repos', 'pr', 'list', ...where(r), '--status', 'active', '--top', '100']);
      if (!list.ok || !Array.isArray(list.value)) {
        incomplete.push(repo.alias);
        continue;
      }
      for (const pr of list.value) {
        const row = prInfoOf(r, repo.alias, pr, me);
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
    const pol: AzResult<AzPolicy[]> = pr.status === 'active' ? await policies(run, cwd, r, pr.pullRequestId!) : { ok: true, value: [] };
    if (!pol.ok) return { kind: 'error', error: pol.error };
    const ship = shipPrOf(r, pr, pol.value);
    return ship ? { kind: 'pr', pr: ship } : { kind: 'error', error: "couldn't read what az said about the PR" };
  },

  async prByNumber(run, cwd, repoId, number) {
    const r = repoAt(cwd);
    if (!r || `${r.org}/${r.project}/${r.repo}`.toLowerCase() !== repoId)
      return { ok: false, error: `PR #${number}: its repo isn't this folder's` };
    const shown = await az<AzPr>(run, cwd, ['repos', 'pr', 'show', '--id', String(number), '--org', r.orgUrl]);
    if (!shown.ok) return { ok: false, error: `PR #${number} in ${r.repo}: ${shown.error}` };
    // PR numbers are the organisation's, not the repo's: #N may be another repo's PR.
    const on = shown.value?.repository;
    if (lower(on?.name) !== lower(r.repo) || lower(on?.project?.name) !== lower(r.project))
      return { ok: false, error: `PR #${number} is in ${on?.project?.name ?? '?'}/${on?.name ?? '?'}, not ${r.project}/${r.repo}` };
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
    // Into the repo's default branch, as `az repos pr create` would; through the REST API, so the title and
    // description travel in a file, never on argv (a line break there ended the command on Windows).
    const repo = await invoke<{ defaultBranch?: string }>(run, cwd, r, 'repositories', {});
    if (!repo.ok) return { ok: false, error: repo.error };
    const target = repo.value?.defaultBranch;
    if (!target) return { ok: false, error: `couldn't tell ${r.repo}'s default branch` };
    const made = await invoke<AzPr>(run, cwd, r, 'pullRequests', {}, 'POST', {
      sourceRefName: `refs/heads/${branch}`,
      targetRefName: target,
      title: subject,
      description: body,
      isDraft: opts.draft,
    });
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
    if (!done.ok) return { ok: false, error: done.error };
    // Merged only when Azure DevOps says completed: a completion it only queued (policies still running) isn't.
    const status = done.value?.status;
    if (status === 'completed') return { ok: true };
    const why = done.value?.mergeStatus && done.value.mergeStatus !== 'succeeded' ? ` (merge: ${done.value.mergeStatus})` : '';
    const queued = status === 'active' ? ': its completion may be queued until its policies pass' : '';
    return { ok: false, error: `Azure DevOps didn't complete PR #${number}, it is ${status ?? 'in an unknown state'}${why}${queued}` };
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
    const list = await az<AzPr[]>(run, cwd, ['repos', 'pr', 'list', ...where(r), '--status', 'active', '--top', String(OPEN_PR_LIMIT)]);
    if (!list.ok) return { ok: false, error: list.error };
    // Not a list is not "no PRs": the review queue would drop every review of the repo.
    if (!Array.isArray(list.value)) return { ok: false, error: "couldn't read what az said" };
    return {
      ok: true,
      prs: list.value.flatMap((p) => openPrOf(r, p) ?? []),
      ...(list.value.length >= OPEN_PR_LIMIT ? { more: true } : {}),
    };
  },

  // Each comment its own thread, then the summary, then the vote: what went out before a failure is said, so a retry
  // sends none of it again; a call that failed without a clear refusal may have gone through (`inDoubt`), and the
  // steps after it weren't tried (`rest`: if it went, the review went only in part).
  async submitReview(run, cwd, number, review): Promise<SubmitReviewResult> {
    const r = repoAt(cwd);
    if (!r) return { ok: false, error: "this repo's origin isn't an Azure DevOps one" };
    // The push the review read: its comments are anchored there (nothing is posted when it can't be found).
    const iteration = review.comments.length ? await iterationAt(run, cwd, r, number, review.commitId) : null;
    if (iteration && !iteration.ok) return { ok: false, error: iteration.error, posted: 0 };
    const summary = !!review.body.trim();
    const vote = review.event !== 'comment';
    for (const [i, c] of review.comments.entries()) {
      const made = await postThread(run, cwd, r, number, c, iteration?.ok ? iteration.value : 0);
      if (!made.ok)
        return {
          ok: false,
          error: `${c.path}:${c.line}: ${made.error}`,
          posted: i,
          ...(made.uncertain
            ? { inDoubt: { comments: [i], summary: false, rest: i < review.comments.length - 1 || summary || vote } }
            : {}),
        };
    }
    if (summary) {
      const general = await invoke(run, cwd, r, 'pullRequestThreads', { pullRequestId: number }, 'POST', {
        comments: [{ parentCommentId: 0, content: review.body, commentType: 1 }],
        status: 'active',
      });
      if (!general.ok)
        return {
          ok: false,
          error: `the summary: ${general.error}`,
          posted: review.comments.length,
          ...(general.uncertain ? { inDoubt: { comments: [], summary: true, rest: vote } } : {}),
        };
    }
    // The verdict as Azure DevOps votes: approve 10, wait for author −5; a plain comment leaves the vote as it is.
    // A vote set twice is the same vote: a retry may send it again.
    if (review.event !== 'comment') {
      const vote = review.event === 'approve' ? 'approve' : 'wait-for-author';
      const v = await az(run, cwd, ['repos', 'pr', 'set-vote', '--id', String(number), '--vote', vote, '--org', r.orgUrl]);
      if (!v.ok)
        return {
          ok: false,
          error: `the comments went out, the vote didn't: ${v.error}`,
          posted: review.comments.length,
          summaryPosted: summary,
        };
    }
    return { ok: true, url: prWebUrl(r, number) };
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
    repoOf: azureThreadRepoId,
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

  rateLimited: (text) => THROTTLED.test(text),
  // A completed PR's merge commit is the user's own (Azure DevOps commits as the person completing it).
  hostCommit: () => false,
  commands: azureCommands,
};
