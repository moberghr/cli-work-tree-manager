import { fetchIssueDetail, fetchJiraPane, fetchMyIssuesOrThrow, type JiraIssue } from '../jira/jira.js';
import { branchFor, jiraPrompt } from '../jira/jira-prompt.js';
import type { Issue, IssueSource } from './issue-source.js';

/** A Jira key: a project key, a dash, a number (`PAY-12`). */
const JIRA_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

/** A Jira issue as an issue: the same fields, with where it is from. Pure. */
export function jiraAsIssue(issue: JiraIssue): Issue {
  return {
    source: 'jira',
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    ...(issue.statusCategory ? { statusCategory: issue.statusCategory } : {}),
    issuetype: issue.issuetype,
    priority: issue.priority,
    url: issue.url,
  };
}

/**
 * Jira behind the issue contract (issue-source.ts), through `acli` (core/jira/jira.ts). The project key is a
 * issue's scope, its components and labels what narrow it. `deps`: a test's.
 */
export function jiraSource(
  deps: {
    pane?: typeof fetchJiraPane;
    all?: typeof fetchMyIssuesOrThrow;
    detail?: typeof fetchIssueDetail;
  } = {},
): IssueSource {
  const pane = deps.pane ?? fetchJiraPane;
  const all = deps.all ?? fetchMyIssuesOrThrow;
  const detail = deps.detail ?? fetchIssueDetail;
  return {
    id: 'jira',
    name: 'Jira',
    async mine() {
      const r = await pane();
      return { available: r.available, issues: r.issues.map(jiraAsIssue) };
    },
    async mineOrThrow() {
      return (await all()).map(jiraAsIssue);
    },
    async detail(key) {
      const d = await detail(key);
      return d ? { scope: d.project, facets: [...d.components, ...d.labels], description: d.description, created: d.created } : null;
    },
    scopeOf: (key) => (JIRA_KEY.test(key) ? key.split('-')[0] : null),
    isKey: (text) => JIRA_KEY.test(text),
    branchFor: (issue) => branchFor(issue),
    prompt: (issue, opts) => jiraPrompt(issue, opts),
  };
}

/** The connectors there are. One today; a new one is added here (and to `ISSUE_SOURCES`, issue-place.ts). */
export function issueSources(): IssueSource[] {
  return [jiraSource()];
}
