import type { JiraIssue, JiraIssueDetail } from '../jira/jira.js';
import type { WorkConfig } from '../platform/config.js';
import { jiraSource } from './jira-source.js';
import type { PlacedIssue } from './issue-place.js';
import { placeBySource, placedIssue } from './issue-source.js';

const asDetail = (d: Pick<JiraIssueDetail, 'project' | 'components' | 'labels'> | null | undefined) =>
  d ? { scope: d.project, facets: [...d.components, ...d.labels] } : d;

/**
 * A Jira issue as your issue rules see it (issue-place.ts): its project, and its components and labels when
 * they are known (a list of issues doesn't carry them; one issue's detail does).
 */
export function jiraPlaced(
  issue: Pick<JiraIssue, 'key'>,
  detail?: Pick<JiraIssueDetail, 'project' | 'components' | 'labels'> | null,
): PlacedIssue {
  // A key that isn't Jira's shape (an older session's) still names its project by what precedes the dash.
  return (
    placedIssue(jiraSource(), issue.key, asDetail(detail)) ?? {
      source: 'jira',
      scope: issue.key.split('-')[0],
      ...(detail ? { facets: [...detail.components, ...detail.labels] } : {}),
    }
  );
}

/**
 * Where your issue rules start a Jira issue: a project, a reason they don't settle it (several named, or one
 * that isn't yours), or null (no rule is about it). The projects are your groups and repos by name.
 */
export function placeJira(
  issue: Pick<JiraIssue, 'key'>,
  detail: Pick<JiraIssueDetail, 'project' | 'components' | 'labels'> | null | undefined,
  cfg: Pick<WorkConfig, 'repos' | 'groups' | 'issues'> | null,
): { target: string; reason: string; auto: boolean } | { target: null; reason: string } | null {
  return placeBySource(jiraSource(), issue.key, asDetail(detail), cfg);
}
