import type { JiraIssue, PrInfo } from '../api/panes.js';
import { jiraPrompt as coreJiraPrompt } from '../../../core/jira/jira-prompt.js';

/**
 * First messages for a session started from a ticket or a PR. They're a
 * starting point the user can edit in the New worktree dialog before
 * anything runs.
 */

/** Shared with the Jira watch (core/jira-prompt.ts), so both start a session the same way. */
export function jiraPrompt(issue: JiraIssue): string {
  return coreJiraPrompt(issue);
}

/**
 * The New worktree dialog for a PR's Start or Review: its repo, its branch,
 * and `prPrompt`. A fork's branch isn't on origin — `work tree` would make an
 * empty one of that name — so its review gets a branch of its own
 * (`review/pr-N`) and checks the PR's code out there.
 */
export function prPick(pr: PrInfo): { target: string; branch: string; prompt: string } {
  return { target: pr.repoAlias, branch: pr.fork ? `review/pr-${pr.number}` : pr.branch, prompt: prPrompt(pr) };
}

/**
 * Someone else's PR is reviewed, never changed: read it, try it, and tell
 * me what I'd comment. Your own is continued: fix what's red, answer the
 * review.
 */
export function prPrompt(pr: PrInfo): string {
  if (!pr.isMine) {
    return [
      `Review PR #${pr.number}: ${pr.title}`,
      pr.url,
      '',
      ...(pr.fork
        ? [`It comes from a fork, so its branch isn't here: gh pr checkout ${pr.number} --detach gives you its code to try.`]
        : []),
      `It isn't mine: read what it changes (gh pr diff ${pr.number}), run what's useful to check it, and tell me what you'd comment and why.`,
      "Don't commit, push or post anything on GitHub.",
    ].join('\n');
  }
  const lines = [`Continue on PR #${pr.number}: ${pr.title}`, pr.url, ''];
  if (pr.conflicting) {
    lines.push(
      `It conflicts with its base branch. Bring the base in (git fetch, then merge it), resolve the conflicts, and run the tests.`,
    );
  }
  if (pr.checksStatus === 'FAILURE') {
    lines.push('Its checks are failing. Find out why (gh pr checks, then the failing job logs) and fix them.');
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    lines.push(`Review asked for changes. Address the review comments (gh pr view ${pr.number} --comments). Don't reply on GitHub.`);
  }
  if (lines.length === 3) lines.push('Get up to speed on what it changes (gh pr diff) and tell me where it stands.');
  return lines.join('\n');
}
