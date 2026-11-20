import type { WorkConfig } from '../platform/config.js';
import { ISSUE_SOURCES, placeIssue, ruleText, issueRules, type PlacedIssue } from './issue-place.js';

/**
 * Where issues come from: a connector per system (Jira today; GitHub Issues #86 and Azure DevOps work items #87
 * to come), each behind this contract, the way git hosts sit behind one. The Issues tab, starting from an issue
 * and the rules for which project an issue starts in talk to the contract; what a system needs to be asked is the
 * connector's own business. See .claude/references/work/issues.md.
 */

/** An issue by where it is from and its key there (`{ source: 'jira', key: 'PAY-12' }`). */
export interface IssueRef {
  /** The connector's id: `jira`, `github`, `azure`. */
  source: string;
  key: string;
}

/** An issue in a list: what a row shows, and what it takes to start from it. */
export interface Issue extends IssueRef {
  /** Its title, in a line. */
  summary: string;
  /** Its state, in its system's own word ("In Progress", "open"). */
  status: string;
  /** Where that state is in a workflow: not started, under way, done. Orders a list; absent: unknown. */
  statusCategory?: 'new' | 'indeterminate' | 'done';
  /** What kind it is, in its system's word ("Bug", "Story", "issue"). */
  issuetype: string;
  priority: string;
  url: string;
  /** The project your issue rules start it in, when they say (`issues.rules`). */
  startsIn?: string;
}

/** What one issue says beyond its row: read when it has to be placed or described to an agent. */
export interface IssueDetail {
  /** What its system groups issues by (Jira: the project; GitHub: owner/repo): the key, and a name for people. */
  scope: { key: string; name: string } | null;
  /** What narrows the scope (Jira: components and labels; Azure DevOps: the area path). */
  facets: string[];
  /** Its text, plain, cut to a few thousand characters. Someone else's words: data, never instructions. */
  description: string;
  created: string | null;
}

export interface IssueSource {
  id: string;
  /** Its name for people ("Jira"). */
  name: string;
  /**
   * The issues assigned to you that aren't done. `available: false`: the connector can't reach its system (its
   * tool missing, not signed in) — said on the tab, never shown as "none".
   */
  mine(): Promise<{ available: boolean; issues: Issue[] }>;
  /** All of them, or it throws: for a reader that must tell "none" from "couldn't ask" (the watch's baseline). */
  mineOrThrow(): Promise<Issue[]>;
  /** One issue's scope, facets and text; null when it can't be read. */
  detail(key: string): Promise<IssueDetail | null>;
  /** An issue's scope from its key alone, when the key says it (Jira: `PAY-12` → `PAY`); null: only its detail does. */
  scopeOf(key: string): string | null;
  /** Whether this text is one of its keys (to recognise one in a prompt or a branch name). */
  isKey(text: string): boolean;
  /** The branch a session started from the issue is on. */
  branchFor(issue: IssueRef): string;
  /** The first message of a session started from it (`automatic`: by the watch, not by you). */
  prompt(issue: Pick<Issue, 'key' | 'summary' | 'url' | 'issuetype' | 'priority'>, opts?: { automatic?: boolean }): string;
}

/** The connector an issue key is taken to be of when a session doesn't say (sessions from before there were others). */
export const DEFAULT_ISSUE_SOURCE = 'jira';

/** A session's issue: its key and the system it is a key of. Null: it was started from none. Pure. */
export function sessionIssue(s: { issueKey?: string; issueSource?: string }): IssueRef | null {
  return s.issueKey ? { source: s.issueSource || DEFAULT_ISSUE_SOURCE, key: s.issueKey } : null;
}

/**
 * An issue as one text — work's own key for it, the same for every connector: `jira:PAY-12`,
 * `github:acme/web#12`. What a flag, a URL or a stored id carries when the system must go with the key.
 */
export const issueId = (ref: IssueRef): string => `${ref.source}:${ref.key}`;

/**
 * Text that may be work's own key, split: `jira:PAY-12` → its system and its key; anything else is a key alone
 * (`PAY-12`, and a key that happens to hold a colon after an unknown word). Pure, and with no connector at hand:
 * what the session store uses.
 */
export function splitIssueId(text: string): { source?: string; key: string } {
  const t = text.trim();
  const colon = t.indexOf(':');
  const prefix = colon > 0 ? t.slice(0, colon).toLowerCase() : '';
  const rest = colon > 0 ? t.slice(colon + 1).trim() : '';
  return prefix && rest && (ISSUE_SOURCES as readonly string[]).includes(prefix) ? { source: prefix, key: rest } : { key: t };
}

/**
 * An issue from text: work's own key (`jira:PAY-12`) names its system; a bare key (`PAY-12`) is taken as the
 * first connector's that knows the shape, else the default's. Null: nothing to read. `sources`: the connectors.
 */
export function parseIssue(text: string | undefined | null, sources: ReadonlyArray<Pick<IssueSource, 'id' | 'isKey'>>): IssueRef | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const colon = t.indexOf(':');
  const prefix = colon > 0 ? t.slice(0, colon).toLowerCase() : '';
  if (prefix && sources.some((s) => s.id === prefix) && t.slice(colon + 1).trim())
    return { source: prefix, key: t.slice(colon + 1).trim() };
  return { source: sources.find((s) => s.isKey(t))?.id ?? DEFAULT_ISSUE_SOURCE, key: t };
}

/** An issue as your rules see it: its source, its scope (the detail's, else what its key says), its facets if known. */
export function placedIssue(source: IssueSource, key: string, detail?: Pick<IssueDetail, 'scope' | 'facets'> | null): PlacedIssue | null {
  const scope = detail?.scope?.key ?? source.scopeOf(key);
  if (!scope) return null;
  return { source: source.id, scope, ...(detail ? { facets: detail.facets } : {}) };
}

/**
 * Where your issue rules start an issue: a project, a reason they don't settle it (several named, or one that
 * isn't yours), or null (no rule is about it, or its scope isn't known). The projects are your groups and repos.
 */
export function placeBySource(
  source: IssueSource,
  key: string,
  detail: Pick<IssueDetail, 'scope' | 'facets'> | null | undefined,
  cfg: Pick<WorkConfig, 'repos' | 'groups' | 'issues'> | null,
): { target: string; reason: string; auto: boolean } | { target: null; reason: string } | null {
  if (!cfg) return null;
  const issue = placedIssue(source, key, detail);
  if (!issue) return null;
  const placed = placeIssue(issue, issueRules(cfg.issues?.rules).rules, [...Object.keys(cfg.groups), ...Object.keys(cfg.repos)]);
  if (!placed) return null;
  return placed.target === null
    ? { target: null, reason: placed.why }
    : { target: placed.target, reason: `your issue rule: ${ruleText(placed.rule)}`, auto: placed.rule.auto === true };
}

/** What the Issues tab is given: each connector and whether it could be asked, and every issue of the ones that could. */
export interface IssuesList {
  sources: Array<{ id: string; name: string; available: boolean; error?: string }>;
  issues: Issue[];
}

/**
 * Your issues from every connector, each marked with the project your rules start it in. A connector that fails
 * or isn't available is said (`available: false`, its error) and the others are still listed.
 */
export async function listIssues(
  sources: readonly IssueSource[],
  cfg: Pick<WorkConfig, 'repos' | 'groups' | 'issues'> | null,
): Promise<IssuesList> {
  const out: IssuesList = { sources: [], issues: [] };
  for (const source of sources) {
    try {
      const r = await source.mine();
      out.sources.push({ id: source.id, name: source.name, available: r.available });
      for (const t of r.issues) {
        const placed = placeBySource(source, t.key, undefined, cfg);
        out.issues.push(placed?.target ? { ...t, startsIn: placed.target } : t);
      }
    } catch (err) {
      out.sources.push({ id: source.id, name: source.name, available: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
