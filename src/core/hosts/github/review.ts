import type { CommandRunner } from '../../platform/command-runner.js';
import { threadCode, type ReviewComment, type ReviewFeedback } from '../../pr/review-types.js';

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

/** The login gh is signed in as (`gh api user`); null when gh can't say. */
export async function githubViewer(run: CommandRunner, cwd: string): Promise<string | null> {
  const r = await run('gh', ['api', 'user', '--jq', '.login'], cwd).catch(() => null);
  const login = r?.code === 0 ? r.stdout.trim() : '';
  return login || null;
}

export async function githubReviewFeedback(run: CommandRunner, repoPath: string, prNumber: number): Promise<ReviewFeedback | null> {
  // gh fills {owner}/{repo} from the repository in the cwd.
  const res = await run(
    'gh',
    ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${prNumber}`, '-f', `query=${QUERY}`],
    repoPath,
  );
  return res.code === 0 ? parseReviewFeedback(res.stdout) : null;
}
