import type { CommandRunner } from '../../platform/command-runner.js';
import { threadCode, type ReviewComment, type ReviewFeedback } from '../../pr/review-types.js';
import { ghApi, type ServerDeps } from './server.js';
import type { PrDiscussionCommentWire, PrDiscussionReviewWire, PrDiscussionThreadWire } from '../../api-types.js';
import type { HostResult, PrDiscussion } from '../types.js';
import { discussionBody, MAX_THREAD_COMMENTS, reviewStateOf } from '../discussion.js';
import { reasonLine } from './pr-ops.js';

/**
 * GitHub's review feedback: one `gh api graphql` call per PR fetches its
 * review threads (with GitHub's resolved flag), review summaries and
 * conversation comments, plus who you are. Moved from core/pr/pr-review.ts,
 * which re-exports what tests import.
 */

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalStartLine originalLine
          head: comments(first: 1) { nodes { diffHunk } }
          comments(last: 20) { nodes { id author { login } authorAssociation body url createdAt } }
        }
      }
      reviews(last: 30) { nodes { id state author { login } authorAssociation body url submittedAt } }
      comments(last: 50) { nodes { id author { login } authorAssociation body url createdAt } }
    }
  }
}`;

type Node = {
  id: string;
  author?: { login?: string } | null;
  authorAssociation?: string;
  body?: string;
  url?: string;
  createdAt?: string;
  submittedAt?: string;
};
const comment = (n: Node): ReviewComment => ({
  id: n.id,
  author: n.author?.login ?? 'ghost',
  association: n.authorAssociation ?? 'NONE',
  body: n.body ?? '',
  url: n.url ?? '',
  createdAt: n.createdAt ?? n.submittedAt ?? '',
});

/** Parse `gh api graphql` output (exported for tests). */
export function parseReviewFeedback(stdout: string): ReviewFeedback | null {
  try {
    const j = JSON.parse(stdout) as {
      data?: {
        viewer?: { login?: string };
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: Array<{
                id: string;
                isResolved: boolean;
                isOutdated?: boolean;
                path?: string | null;
                line?: number | null;
                originalStartLine?: number | null;
                originalLine?: number | null;
                head?: { nodes?: Array<{ diffHunk?: string | null }> };
                comments?: { nodes?: Node[] };
              }>;
            };
            reviews?: { nodes?: Array<Node & { state?: string }> };
            comments?: { nodes?: Node[] };
          } | null;
        } | null;
      };
    };
    const pr = j.data?.repository?.pullRequest;
    // Who you are tells your words from a reviewer's: without it the lookup failed (callers
    // keep the last count), it isn't "no threads".
    if (!pr || !j.data?.viewer?.login) return null;
    return {
      viewer: j.data.viewer.login,
      threads: (pr.reviewThreads?.nodes ?? []).map((t) => ({
        id: t.id,
        isResolved: !!t.isResolved,
        isOutdated: !!t.isOutdated,
        path: t.path ?? null,
        line: t.line ?? null,
        code: threadCode(t.head?.nodes?.[0]?.diffHunk, t.originalStartLine, t.originalLine, !!t.isOutdated),
        comments: (t.comments?.nodes ?? []).map(comment),
      })),
      reviews: (pr.reviews?.nodes ?? []).map((r) => ({ ...comment(r), state: r.state ?? 'COMMENTED' })),
      comments: (pr.comments?.nodes ?? []).map(comment),
    };
  } catch {
    return null;
  }
}

/**
 * The login gh is signed in as on the server of the repo at `cwd` (`gh api user` on that server: on a GitHub
 * Enterprise one you are someone else); null when gh can't say, or which server it is isn't known.
 */
export async function githubViewer(run: CommandRunner, cwd: string, deps?: ServerDeps): Promise<string | null> {
  const r = await ghApi(run, cwd, ['user', '--jq', '.login'], deps).catch(() => null);
  const login = r?.code === 0 ? r.stdout.trim() : '';
  return login || null;
}

export async function githubReviewFeedback(
  run: CommandRunner,
  repoPath: string,
  prNumber: number,
  deps?: ServerDeps,
): Promise<ReviewFeedback | null> {
  // gh fills {owner}/{repo} from the repository in the cwd; the server is the repo's own (its viewer is who you are there).
  const res = await ghApi(
    run,
    repoPath,
    ['graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${prNumber}`, '-f', `query=${QUERY}`],
    deps,
  );
  return res.code === 0 ? parseReviewFeedback(res.stdout) : null;
}

/**
 * A PR's whole discussion, read only (the Reviews tab, #64): every review thread with its side, place, outdated and
 * resolved flags and its comments; the submitted reviews (not a pending one: your own draft); the conversation
 * comments; and the PR's `updatedAt`, which decides when it's read again.
 */
const DISCUSSION_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      updatedAt
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: ${MAX_THREAD_COMMENTS}) { totalCount nodes { author { login } authorAssociation body url createdAt } }
        }
      }
      reviews(last: 50) { pageInfo { hasPreviousPage } nodes { state author { login } authorAssociation body url submittedAt } }
      comments(last: 100) { pageInfo { hasPreviousPage } nodes { author { login } authorAssociation body url createdAt } }
    }
  }
}`;

type DNode = {
  author?: { login?: unknown } | null;
  authorAssociation?: unknown;
  body?: unknown;
  url?: unknown;
  createdAt?: unknown;
  submittedAt?: unknown;
  state?: unknown;
};
const dstr = (v: unknown) => (typeof v === 'string' ? v : '');
const dcomment = (n: DNode): PrDiscussionCommentWire => {
  const association = dstr(n.authorAssociation);
  const url = dstr(n.url);
  return {
    // gh names an app `app/dependabot` in some answers; a deleted account is GitHub's "ghost".
    author: dstr(n.author?.login).replace(/^app\//, '') || 'ghost',
    ...(association ? { association } : {}),
    body: discussionBody(n.body),
    at: dstr(n.createdAt) || dstr(n.submittedAt),
    ...(url ? { url } : {}),
  };
};

/** Parse the discussion query's answer (exported for tests); null when it isn't one. */
export function parseGithubDiscussion(stdout: string): PrDiscussion | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  type Page<T> = { pageInfo?: { hasNextPage?: unknown; hasPreviousPage?: unknown }; nodes?: Array<T | null> };
  const pr = (
    j as {
      data?: {
        repository?: {
          pullRequest?: {
            updatedAt?: unknown;
            reviewThreads?: Page<{
              id?: unknown;
              isResolved?: unknown;
              isOutdated?: unknown;
              path?: unknown;
              line?: unknown;
              originalLine?: unknown;
              diffSide?: unknown;
              comments?: { totalCount?: unknown; nodes?: Array<DNode | null> };
            }>;
            reviews?: Page<DNode>;
            comments?: Page<DNode>;
          } | null;
        } | null;
      };
    } | null
  )?.data?.repository?.pullRequest;
  if (!pr || typeof pr !== 'object') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
  const threads = (pr.reviewThreads?.nodes ?? []).flatMap((t): PrDiscussionThreadWire[] => {
    if (!t || typeof t.id !== 'string') return [];
    const comments = (t.comments?.nodes ?? []).flatMap((c) => (c ? [dcomment(c)] : []));
    if (!comments.length) return [];
    const original = num(t.originalLine);
    return [
      {
        id: t.id,
        path: dstr(t.path) || null,
        line: num(t.line),
        ...(original !== null ? { originalLine: original } : {}),
        side: t.diffSide === 'LEFT' ? 'left' : 'right',
        outdated: t.isOutdated === true,
        resolved: t.isResolved === true,
        ...(comments[0].url ? { url: comments[0].url } : {}),
        comments,
      },
    ];
  });
  const reviews = (pr.reviews?.nodes ?? []).flatMap((r): PrDiscussionReviewWire[] => {
    const state = r ? reviewStateOf(r.state) : null;
    return r && state ? [{ ...dcomment(r), state }] : [];
  });
  const comments = (pr.comments?.nodes ?? []).flatMap((c) => (c ? [dcomment(c)] : []));
  const more =
    pr.reviewThreads?.pageInfo?.hasNextPage === true ||
    pr.reviews?.pageInfo?.hasPreviousPage === true ||
    pr.comments?.pageInfo?.hasPreviousPage === true ||
    (pr.reviewThreads?.nodes ?? []).some((t) => typeof t?.comments?.totalCount === 'number' && t.comments.totalCount > MAX_THREAD_COMMENTS);
  const updatedAt = dstr(pr.updatedAt);
  return { ...(updatedAt ? { updatedAt } : {}), threads, reviews, comments, ...(more ? { more: true as const } : {}) };
}

/** `gh api graphql` on the repo's own server (`ghApi`; gh fills owner and repo from the cwd): a read, never a mutation. */
export async function githubDiscussion(
  run: CommandRunner,
  repoPath: string,
  prNumber: number,
  deps?: ServerDeps,
): Promise<HostResult<{ discussion: PrDiscussion }>> {
  const res = await ghApi(
    run,
    repoPath,
    ['graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${prNumber}`, '-f', `query=${DISCUSSION_QUERY}`],
    deps,
  );
  if (res.code === 127) return { ok: false, error: 'GitHub CLI (gh) not found' };
  if (res.code !== 0) return { ok: false, error: reasonLine(res.stderr) || "gh couldn't read the PR's discussion" };
  const discussion = parseGithubDiscussion(res.stdout);
  return discussion ? { ok: true, discussion } : { ok: false, error: "couldn't read what gh said about the PR's discussion" };
}
