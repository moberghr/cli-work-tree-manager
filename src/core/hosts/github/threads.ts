import { json } from '../../platform/db.js';
import type { CommandRunner } from '../../platform/command-runner.js';
import type { HostResult, LiveThread, ThreadNow } from '../types.js';

/**
 * GitHub's review threads through `gh api graphql` (-f: raw strings, never
 * @file or number parsing; argv only). Thread ids are GitHub's global node
 * ids (`PRRT_…`), so any of the session's folders works as the cwd. Moved
 * from core/pr/pr-replies.ts; the queries and their reading are unchanged.
 */

export { GITHUB_THREAD_ID } from './origin.js';

const ADD_REPLY = `mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { url } }
}`;
const RESOLVE = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }`;
/** The thread as it is now, and who you are: the last check before a reply goes out. */
const THREAD_NOW = `query($threadId: ID!) {
  viewer { login }
  node(id: $threadId) { ... on PullRequestReviewThread { isResolved comments(last: 1) { nodes { author { login } } } } }
}`;
/** A thread as GitHub has it now, with its pull request: what a draft can be made from when work's last check hasn't it. */
const THREAD_LIVE = `query($threadId: ID!) {
  viewer { login }
  node(id: $threadId) { ... on PullRequestReviewThread {
    isResolved isOutdated path line originalStartLine originalLine
    first: comments(first: 1) { nodes { author { login } body url diffHunk } }
    last: comments(last: 1) { nodes { author { login } url } }
    pullRequest { number url headRefName repository { nameWithOwner } }
  } }
}`;
const THREAD_RESOLVED = `query($threadId: ID!) { node(id: $threadId) { ... on PullRequestReviewThread { isResolved } } }`;

const graphql = (run: CommandRunner, cwd: string, query: string, vars: Record<string, string>) =>
  run('gh', ['api', 'graphql', '-f', `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ['-f', `${k}=${v}`])], cwd);

export async function githubThreadNow(run: CommandRunner, cwd: string, id: string): Promise<HostResult<{ thread: ThreadNow }>> {
  const r = await graphql(run, cwd, THREAD_NOW, { threadId: id });
  if (r.code !== 0) return { ok: false, error: `couldn't read the thread on GitHub first: ${r.stderr.trim() || 'gh failed'}` };
  const j = json.parse(r.stdout) as {
    data?: {
      viewer?: { login?: unknown };
      node?: { isResolved?: unknown; comments?: { nodes?: Array<{ author?: { login?: unknown } | null } | null> } } | null;
    };
  } | null;
  const me = j?.data?.viewer?.login;
  const node = j?.data?.node;
  if (typeof me !== 'string' || !me || !node) return { ok: false, error: "couldn't read the thread on GitHub first" };
  const last = node.comments?.nodes?.at(-1)?.author?.login;
  return { ok: true, thread: { viewer: me, resolved: node.isResolved === true, lastAuthor: typeof last === 'string' ? last : null } };
}

export async function githubThreadLive(run: CommandRunner, cwd: string, id: string): Promise<HostResult<{ thread: LiveThread }>> {
  const r = await graphql(run, cwd, THREAD_LIVE, { threadId: id });
  if (r.code !== 0) return { ok: false, error: `couldn't read the thread on GitHub: ${r.stderr.trim() || 'gh failed'}` };
  type Who = { author?: { login?: unknown } | null; body?: unknown; url?: unknown; diffHunk?: unknown } | null;
  const j = json.parse(r.stdout) as {
    data?: {
      viewer?: { login?: unknown };
      node?: {
        isResolved?: unknown;
        isOutdated?: unknown;
        path?: unknown;
        line?: unknown;
        originalStartLine?: unknown;
        originalLine?: unknown;
        first?: { nodes?: Who[] };
        last?: { nodes?: Who[] };
        pullRequest?: { number?: unknown; url?: unknown; headRefName?: unknown; repository?: { nameWithOwner?: unknown } };
      } | null;
    };
  } | null;
  const me = j?.data?.viewer?.login;
  const t = j?.data?.node;
  const pr = t?.pullRequest;
  if (typeof me !== 'string' || !me || !t || !pr || typeof pr.number !== 'number')
    return { ok: false, error: `${id} isn't a review thread GitHub knows` };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  const first = t.first?.nodes?.[0];
  const last = t.last?.nodes?.at(-1);
  return {
    ok: true,
    thread: {
      viewer: me,
      resolved: t.isResolved === true,
      outdated: t.isOutdated === true,
      path: str(t.path) || null,
      line: num(t.line),
      originalStartLine: num(t.originalStartLine),
      originalLine: num(t.originalLine),
      first: first
        ? { author: str(first.author?.login), body: str(first.body), url: str(first.url), diffHunk: str(first.diffHunk) || null }
        : null,
      last: last ? { author: str(last.author?.login), url: str(last.url) } : null,
      pr: {
        number: pr.number,
        url: str(pr.url),
        headBranch: str(pr.headRefName),
        repoId: str(pr.repository?.nameWithOwner).toLowerCase(),
      },
    },
  };
}

export async function githubThreadResolved(run: CommandRunner, cwd: string, id: string): Promise<boolean | null> {
  const res = await graphql(run, cwd, THREAD_RESOLVED, { threadId: id });
  if (res.code !== 0) return null;
  const j = json.parse(res.stdout) as { data?: { node?: { isResolved?: unknown } | null } } | null;
  const v = j?.data?.node?.isResolved;
  return typeof v === 'boolean' ? v : null;
}

export async function githubThreadReply(run: CommandRunner, cwd: string, id: string, body: string): Promise<HostResult<{ url?: string }>> {
  const add = await graphql(run, cwd, ADD_REPLY, { threadId: id, body });
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || 'gh could not post the reply' };
  const parsed = json.parse(add.stdout) as { data?: { addPullRequestReviewThreadReply?: { comment?: { url?: unknown } } } } | null;
  const got = parsed?.data?.addPullRequestReviewThreadReply?.comment?.url;
  return { ok: true, ...(typeof got === 'string' ? { url: got } : {}) };
}

export async function githubThreadResolve(run: CommandRunner, cwd: string, id: string): Promise<boolean> {
  const r = await graphql(run, cwd, RESOLVE, { threadId: id });
  return r.code === 0;
}
