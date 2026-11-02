import os from 'node:os';
import type { GitHost } from '../types.js';
import { githubCommands } from './commands.js';
import { githubRepoId, onGithub, parseGithubPrUrl } from './origin.js';
import { githubPrList } from './pr-list.js';
import {
  githubCreatePr,
  githubMergedPr,
  githubMergePr,
  githubOpenPrs,
  githubPostReviewComment,
  githubPrByNumber,
  githubPrForBranch,
  githubPrState,
  githubSubmitReview,
} from './pr-ops.js';
import { githubReviewFeedback, githubViewer } from './review.js';
import { GITHUB_THREAD_ID } from './origin.js';
import { githubThreadLive, githubThreadNow, githubThreadReply, githubThreadResolve, githubThreadResolved } from './threads.js';

/**
 * GitHub, through the `gh` CLI and the user's own `gh auth login`. The only
 * place outside core/hosts/github/ that knows `gh` is nowhere: everything
 * reaches it through this adapter (tests/architecture/hosts.test.ts).
 */
export const github: GitHost = {
  id: 'github',
  name: 'GitHub',
  cli: {
    cmd: 'gh',
    label: 'GitHub CLI',
    checkArgs: ['auth', 'status'],
    missing: 'Optional: install gh to see your pull requests, CI and review comments.',
    failing: 'Optional: run `gh auth login` so work can see your pull requests.',
  },
  matches: onGithub,
  repoId: githubRepoId,
  parsePrUrl: parseGithubPrUrl,
  prRef: (n) => `refs/pull/${n}/head`,

  // Its own runner (execFile with timeouts): one search for every repo, then gh pr list per repo elsewhere.
  list: async (repos) => githubPrList(Object.fromEntries(repos.map((r) => [r.alias, r.path]))),
  viewer: githubViewer,
  prForBranch: githubPrForBranch,
  prByNumber: githubPrByNumber,
  prState: (run, url) => githubPrState(run, url, os.tmpdir()),
  createPr: githubCreatePr,
  mergePr: githubMergePr,
  mergedPr: githubMergedPr,
  openPrs: githubOpenPrs,
  postReviewComment: githubPostReviewComment,
  submitReview: githubSubmitReview,
  reviewFeedback: (run, cwd, n) => githubReviewFeedback(run, cwd, n),

  threads: {
    isId: (id) => GITHUB_THREAD_ID.test(id),
    now: githubThreadNow,
    live: githubThreadLive,
    isResolved: githubThreadResolved,
    reply: githubThreadReply,
    resolve: githubThreadResolve,
  },

  // gh's words when GitHub's API limit is spent ("API rate limit already exceeded", "secondary rate limit").
  rateLimited: (text) => /rate limit/i.test(text),
  // A squash or merge commit GitHub wrote itself, not your work of that day.
  hostCommit: (email) => email.toLowerCase() === 'noreply@github.com',
  commands: githubCommands,
};
