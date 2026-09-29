import type { JiraIssue, PrInfo } from '../api/panes.js';

/**
 * First messages for a session started from a ticket or a PR. They're a
 * starting point the user can edit in the New worktree dialog before
 * anything runs.
 */

export function jiraPrompt(issue: JiraIssue): string {
  return [
    `Work on ${issue.key}: ${issue.summary}`,
    '',
    `The issue (${issue.issuetype}, ${issue.priority}): ${issue.url}`,
    'Read it first; ask me if the scope is unclear before changing code.',
  ].join('\n');
}

export function prPrompt(pr: PrInfo): string {
  const lines = [`Continue on PR #${pr.number}: ${pr.title}`, pr.url, ''];
  if (pr.checksStatus === 'FAILURE') {
    lines.push('Its checks are failing. Find out why (gh pr checks, then the failing job logs) and fix them.');
  }
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    lines.push(`Review asked for changes. Address the review comments (gh pr view ${pr.number} --comments). Don't reply on GitHub.`);
  }
  if (lines.length === 3) lines.push('Get up to speed on what it changes (gh pr diff) and tell me where it stands.');
  return lines.join('\n');
}
