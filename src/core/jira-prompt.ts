/**
 * The first message of a session started from a Jira issue — by you (the
 * Jira tab fills the New worktree dialog with it) or by the Jira watch.
 * Pure: the SPA imports it.
 */
/** The issue fields it uses (jira.ts's JiraIssue has them; kept here so the SPA can import this). */
export interface PromptIssue {
  key: string;
  summary: string;
  issuetype: string;
  priority: string;
  url: string;
}

export function jiraPrompt(issue: PromptIssue, opts: { automatic?: boolean } = {}): string {
  const lines = [
    `Work on ${issue.key}: ${issue.summary}`,
    '',
    `The issue (${issue.issuetype}, ${issue.priority}): ${issue.url}`,
    'Read it first; ask me if the scope is unclear before changing code.',
  ];
  if (opts.automatic) {
    lines.push(
      '',
      "This session was started automatically when the issue was assigned to me (work's Jira watch picked this repository). If the issue doesn't belong here, don't start: say so on a line beginning with DECISION NEEDED:, and where you think it belongs.",
    );
  }
  return lines.join('\n');
}
