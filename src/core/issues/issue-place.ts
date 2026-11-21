/**
 * Where an issue's work starts: your mapping from where issues come from to one of your projects (a repo or a
 * group). Asked for: a Jira project can be on several boards and span repos, a GitHub issue's repo can be part of
 * a group, so "the board" or "the issue's repo" isn't the answer by itself — you say it once, and work follows it.
 *
 * A rule is one line of the setting `issues.rules`:
 *
 *   <source>:<scope>[/<facet>] -> <project>
 *
 *   jira:PAY -> api                 every issue of the Jira project PAY starts in api
 *   jira:SHOP/checkout -> shop      issues of SHOP with the component or label "checkout" start in the group shop
 *   github:acme/web -> shop         issues of the GitHub repo acme/web start in the group shop
 *   jira:PAY -> api (auto)          …and the watch may start a newly assigned one there by itself
 *   azure:Payments/Core\API -> api  work items of the Azure DevOps project Payments under that area path
 *
 * `source` is a connector's id. `scope` is what that connector groups issues by (Jira: the project key; GitHub:
 * owner/repo; Azure DevOps: the project). `facet` narrows it (Jira: a component or a label; Azure DevOps: an area
 * path): a rule with one is more specific than one without, and wins. `(auto)` after the project lets the watch
 * start a newly assigned issue of the rule by itself; without it (or with `(ask)`) the rule only says where, and
 * the issue waits for your Start. Asked for: nothing starts by itself unless you set it.
 *
 * Pure: the issues, the rules and the project names are all handed in.
 */

/** An issue as the mapping sees it, whatever connector it came from. */
export interface PlacedIssue {
  /** The connector's id: `jira`, `github`, `azure`. */
  source: string;
  /** What the connector groups issues by (Jira: the project key; GitHub: owner/repo; Azure DevOps: the project). */
  scope: string;
  /** What narrows it (Jira: components and labels; Azure DevOps: the area path). Undefined: not known yet (a list
   *  that doesn't carry them) — then only a scope that has ONE answer whatever the facet is placed. */
  facets?: readonly string[];
}

export interface IssueRule {
  source: string;
  scope: string;
  facet?: string;
  /** The project it starts in: a repo's alias or a group's name. */
  target: string;
  /** The watch may start a newly assigned issue of this rule by itself (`(auto)`); absent: it asks you. */
  auto?: true;
}

/** The connectors a rule can name. */
export const ISSUE_SOURCES = ['jira', 'github', 'azure'] as const;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A line of the setting as a rule, or why it isn't one (said where you typed it). The facet is what follows the
 * LAST slash of a Jira or Azure DevOps scope; a GitHub scope is `owner/repo` whole.
 */
export function parseIssueRule(line: string): { ok: true; rule: IssueRule } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  const m = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+?)\s*(?:->|→|=>)\s*(.+?)\s*$/.exec(line);
  if (!m) return bad('write it as  source:scope -> project  (e.g. jira:PAY -> api)');
  const source = m[1].toLowerCase();
  if (!(ISSUE_SOURCES as readonly string[]).includes(source)) return bad(`"${m[1]}" isn't an issue source (${ISSUE_SOURCES.join(', ')})`);
  const where = m[2];
  // What follows the project in brackets: whether the watch may start it by itself.
  const mode = /^(.*?)\s*\(\s*([A-Za-z]+)\s*\)$/.exec(m[3]);
  if (mode && !/^(auto|ask)$/i.test(mode[2])) return bad(`"(${mode[2]})" isn't something a rule says: (auto) or (ask)`);
  const target = (mode ? mode[1] : m[3]).trim();
  if (!target) return bad('no project after the arrow');
  const auto = mode && mode[2].toLowerCase() === 'auto' ? { auto: true as const } : {};
  if (source === 'github') {
    if (!/^[^/\s]+\/[^/\s]+$/.test(where)) return bad('a GitHub scope is owner/repo');
    return { ok: true, rule: { source, scope: where, target, ...auto } };
  }
  const slash = where.indexOf('/');
  const scope = (slash < 0 ? where : where.slice(0, slash)).trim();
  const facet = slash < 0 ? '' : where.slice(slash + 1).trim();
  if (!scope) return bad('the scope is empty');
  if (slash >= 0 && !facet) return bad('nothing follows the slash');
  return { ok: true, rule: { source, scope, ...(facet ? { facet } : {}), target, ...auto } };
}

/** The setting's lines as rules, with the ones that aren't (their text and why). Blank lines are skipped. */
export function issueRules(lines: readonly unknown[] | undefined): {
  rules: IssueRule[];
  invalid: Array<{ line: string; error: string }>;
} {
  const rules: IssueRule[] = [];
  const invalid: Array<{ line: string; error: string }> = [];
  for (const raw of lines ?? []) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const r = parseIssueRule(raw);
    if (r.ok) rules.push(r.rule);
    else invalid.push({ line: raw.trim(), error: r.error });
  }
  return { rules, invalid };
}

export type Placement =
  /** Your mapping says where: start there. */
  | { target: string; rule: IssueRule }
  /** Your mapping names several projects for it, or one that isn't yours: it is yours to decide. */
  | { target: null; why: string }
  /** No rule is about it. */
  | null;

/** A rule as you wrote it, for a reason line. */
export const ruleText = (r: IssueRule): string =>
  `${r.source}:${r.scope}${r.facet ? `/${r.facet}` : ''} -> ${r.target}${r.auto ? ' (auto)' : ''}`;

/**
 * Where the mapping puts an issue. The rules of its source and scope are looked at; ones whose facet the issue has
 * win over ones with none. One project named: there. Several, or a project that isn't one of `projects`: not
 * placed, with why — never a pick between them. With `facets` unknown, a scope is placed only when every rule
 * about it names the same project (a narrower rule might have applied otherwise).
 */
export function placeIssue(issue: PlacedIssue, rules: readonly IssueRule[], projects: readonly string[]): Placement {
  const about = rules.filter((r) => r.source === issue.source && same(r.scope, issue.scope));
  if (about.length === 0) return null;
  let candidates: IssueRule[];
  if (issue.facets === undefined) candidates = about;
  else {
    const narrow = about.filter((r) => r.facet !== undefined && issue.facets!.some((f) => same(f, r.facet!)));
    candidates = narrow.length ? narrow : about.filter((r) => r.facet === undefined);
    if (candidates.length === 0) return null;
  }
  // Rules for one project that disagree on starting it by itself: the careful one holds (it asks).
  const named = [...new Set(candidates.map((r) => r.target.trim().toLowerCase()))];
  if (named.length > 1) {
    const which = [...new Set(candidates.map((r) => r.target.trim()))].join(', ');
    return {
      target: null,
      why:
        issue.facets === undefined
          ? `your issue rules send ${issue.source}:${issue.scope} to ${which}, depending on what it is about`
          : `your issue rules name several projects for it (${which})`,
    };
  }
  const rule = candidates.find((r) => !r.auto) ?? candidates[0];
  const target = projects.find((p) => same(p, rule.target));
  if (!target) return { target: null, why: `your issue rule "${ruleText(rule)}" names ${rule.target}, which isn't one of your projects` };
  return { target, rule };
}
