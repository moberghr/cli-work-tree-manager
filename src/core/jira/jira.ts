import { execFile } from 'node:child_process';

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /** Jira's category for the status: new (to do), indeterminate (in progress, review…), done. Orders the board's columns. */
  statusCategory?: 'new' | 'indeterminate' | 'done';
  issuetype: string;
  priority: string;
  url: string;
}

function execAsync(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // `windowsHide: true` prevents a console window from flashing on
    // Windows whenever the Jira pane refreshes (every 120 s when open).
    // Without it, opening the Jira pane in `work web` triggers a
    // visible terminal popup.
    execFile(cmd, args, { encoding: 'utf-8', timeout, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

/** Run `acli jira auth status` once and parse it for both availability
 *  AND the site URL. Replaces the previous two-call pattern where
 *  `isAcliAvailable` and `getJiraSiteUrl` each shelled out independently. */
async function probeAcli(): Promise<{ available: boolean; siteUrl: string }> {
  try {
    const stdout = await execAsync('acli', ['jira', 'auth', 'status'], 5000);
    const match = stdout.match(/Site:\s+(\S+)/);
    return {
      available: true,
      siteUrl: match ? `https://${match[1]}` : '',
    };
  } catch {
    return { available: false, siteUrl: '' };
  }
}

/** The fields of `acli jira workitem search --json` this reads; all optional — it is someone else's output. */
interface AcliIssue {
  key?: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    priority?: { name?: string };
  };
}

/** Jira's three status categories (the board's column order); anything else isn't one. */
function isStatusCategory(k: unknown): k is NonNullable<JiraIssue['statusCategory']> {
  return k === 'new' || k === 'indeterminate' || k === 'done';
}

function parseIssuesJson(stdout: string, siteUrl: string): JiraIssue[] {
  const parsed = JSON.parse(stdout) as { issues?: AcliIssue[] } | AcliIssue[] | null;
  const issues: AcliIssue[] = (Array.isArray(parsed) ? parsed : parsed?.issues) ?? [];

  return issues.map((issue) => {
    const fields = issue.fields ?? {};
    return {
      key: issue.key ?? '',
      summary: fields.summary ?? '',
      status: fields.status?.name ?? '',
      ...(isStatusCategory(fields.status?.statusCategory?.key) ? { statusCategory: fields.status.statusCategory.key } : {}),
      issuetype: fields.issuetype?.name ?? '',
      priority: fields.priority?.name ?? '',
      url: siteUrl ? `${siteUrl}/browse/${issue.key}` : '',
    };
  });
}

/**
 * Your open issues: by the status's category, not `resolution = Unresolved` — service-desk workflows set a
 * resolution on issues still open ("Waiting for feedback", a Review), which hid them from the Jira tab (SSD-2465).
 */
export const MY_ISSUES_JQL = 'assignee = currentUser() AND statusCategory != Done AND status NOT IN (Archived) ORDER BY updated DESC';

async function searchMyIssues(siteUrl: string): Promise<JiraIssue[]> {
  try {
    const stdout = await execAsync('acli', ['jira', 'workitem', 'search', '--jql', MY_ISSUES_JQL, '--json', '--limit', '50'], 15000);
    if (!stdout) return [];
    return parseIssuesJson(stdout, siteUrl);
  } catch {
    return [];
  }
}

/**
 * Your open issues, or a throw when acli can't list them (not there, signed
 * out, offline) — for the Jira watch, where "none" and "couldn't ask" must
 * differ: an empty list taken for the truth would use up the one-time
 * adoption of issues the list newly shows (`adoptListChange`).
 */
export async function fetchMyIssuesOrThrow(): Promise<JiraIssue[]> {
  const probe = await probeAcli();
  if (!probe.available) throw new Error('acli is not available (installed and signed in?)');
  // All of them, not the 50 most recently updated: one the watch never saw would look newly assigned once it's updated.
  const stdout = await execAsync('acli', ['jira', 'workitem', 'search', '--jql', MY_ISSUES_JQL, '--json', '--paginate'], 60_000);
  return stdout ? parseIssuesJson(stdout, probe.siteUrl) : [];
}

/** An issue's numeric id (Tempo wants it); null when acli can't say. */
export async function issueIdOf(key: string): Promise<number | null> {
  try {
    const stdout = await execAsync('acli', ['jira', 'workitem', 'view', key, '--json'], 15000);
    const j = JSON.parse(stdout) as { id?: unknown };
    const id = typeof j.id === 'string' ? Number(j.id) : j.id;
    return typeof id === 'number' && Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

let accountIdCache: string | null = null;

/**
 * Your Jira account id (what `updatedBy()` wants: acli refuses `currentUser()`
 * inside it), from an issue assigned to you; cached for the process. Null
 * when it can't tell.
 */
export async function myAccountId(): Promise<string | null> {
  if (accountIdCache) return accountIdCache;
  try {
    const stdout = await execAsync(
      'acli',
      [
        'jira',
        'workitem',
        'search',
        '--jql',
        'assignee = currentUser() ORDER BY updated DESC',
        '--fields',
        'assignee',
        '--json',
        '--limit',
        '1',
      ],
      15000,
    );
    const parsed = JSON.parse(stdout) as unknown;
    const list = (Array.isArray(parsed) ? parsed : (parsed as { issues?: unknown[] } | null)?.issues) ?? [];
    const id = (list[0] as { fields?: { assignee?: { accountId?: unknown } } } | undefined)?.fields?.assignee?.accountId;
    accountIdCache = typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
  return accountIdCache;
}

/** The same, but a failure (no acli, signed out, no network) throws: for callers that must tell "none" from "couldn't ask". */
export async function searchIssuesOrThrow(jql: string, limit = 50): Promise<JiraIssue[]> {
  const stdout = await execAsync('acli', ['jira', 'workitem', 'search', '--jql', jql, '--json', '--limit', String(limit)], 15000);
  return stdout ? parseIssuesJson(stdout, '') : [];
}

/**
 * Combined availability check + issue fetch in one acli probe. Used by
 * the dashboard's Jira pane so a refresh only spawns `acli jira auth
 * status` once instead of twice. The pane needs `available` separately
 * from `issues` so it can render the "acli not configured" hint.
 */
export async function fetchJiraPane(): Promise<{
  available: boolean;
  issues: JiraIssue[];
}> {
  const probe = await probeAcli();
  if (!probe.available) return { available: false, issues: [] };
  const issues = await searchMyIssues(probe.siteUrl);
  return { available: true, issues };
}

/** What the Jira watch reads to decide where an issue belongs. */
export interface JiraIssueDetail {
  project: { key: string; name: string } | null;
  components: string[];
  labels: string[];
  /** The description as plain text (from Jira's document format), cut to a few thousand characters. */
  description: string;
  created: string | null;
}

/** Jira's document format (ADF) as plain text: paragraphs and list items on their own lines. Pure. */
export function adfText(node: unknown, max = 4000): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const o = n as { type?: unknown; text?: unknown; content?: unknown };
    if (o.type === 'text' && typeof o.text === 'string') out.push(o.text);
    if (Array.isArray(o.content)) for (const c of o.content) walk(c);
    if (o.type === 'paragraph' || o.type === 'heading' || o.type === 'listItem' || o.type === 'codeBlock') out.push('\n');
  };
  walk(node);
  const text = out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** One issue's project, components, labels and description (`acli jira workitem view`). Null when acli can't say. */
export async function fetchIssueDetail(key: string): Promise<JiraIssueDetail | null> {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return null;
  try {
    const stdout = await execAsync(
      'acli',
      ['jira', 'workitem', 'view', key, '--json', '--fields', 'summary,description,project,components,labels,created'],
      15000,
    );
    const f = (JSON.parse(stdout) as { fields?: Record<string, unknown> }).fields ?? {};
    const p = f.project as { key?: unknown; name?: unknown } | undefined;
    const names = (v: unknown) =>
      Array.isArray(v)
        ? v.map((c) => (typeof c === 'string' ? c : (c as { name?: unknown })?.name)).filter((s): s is string => typeof s === 'string')
        : [];
    return {
      project: p && typeof p.key === 'string' ? { key: p.key, name: typeof p.name === 'string' ? p.name : p.key } : null,
      components: names(f.components),
      labels: names(f.labels),
      description: adfText(f.description),
      created: typeof f.created === 'string' ? f.created : null,
    };
  } catch {
    return null;
  }
}

/** Your assigned, unresolved issues (the Jira tab's list); [] when acli isn't there or fails. */
export async function fetchMyIssues(): Promise<JiraIssue[]> {
  const r = await fetchJiraPane();
  return r.issues;
}
