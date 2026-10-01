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
    execFile(
      cmd,
      args,
      { encoding: 'utf-8', timeout, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout ?? '');
      },
    );
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

function parseIssuesJson(stdout: string, siteUrl: string): JiraIssue[] {
  const parsed = JSON.parse(stdout);
  const issues: any[] = parsed.issues ?? parsed ?? [];

  return issues.map((issue: any) => {
    const fields = issue.fields ?? {};
    return {
      key: issue.key ?? '',
      summary: fields.summary ?? '',
      status: fields.status?.name ?? '',
      ...(['new', 'indeterminate', 'done'].includes(fields.status?.statusCategory?.key) ? { statusCategory: fields.status.statusCategory.key } : {}),
      issuetype: fields.issuetype?.name ?? '',
      priority: fields.priority?.name ?? '',
      url: siteUrl ? `${siteUrl}/browse/${issue.key}` : '',
    };
  });
}

async function searchMyIssues(siteUrl: string): Promise<JiraIssue[]> {
  try {
    const stdout = await execAsync(
      'acli',
      [
        'jira', 'workitem', 'search',
        '--jql', 'assignee = currentUser() AND resolution = Unresolved AND status NOT IN (Archived, Done) ORDER BY updated DESC',
        '--json',
        '--limit', '50',
      ],
      15000,
    );
    if (!stdout) return [];
    return parseIssuesJson(stdout, siteUrl);
  } catch {
    return [];
  }
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
  const text = out.join('').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/** One issue's project, components, labels and description (`acli jira workitem view`). Null when acli can't say. */
export async function fetchIssueDetail(key: string): Promise<JiraIssueDetail | null> {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return null;
  try {
    const stdout = await execAsync('acli', ['jira', 'workitem', 'view', key, '--json', '--fields', 'summary,description,project,components,labels,created'], 15000);
    const f = (JSON.parse(stdout) as { fields?: Record<string, unknown> }).fields ?? {};
    const p = f.project as { key?: unknown; name?: unknown } | undefined;
    const names = (v: unknown) => (Array.isArray(v) ? v.map((c) => (typeof c === 'string' ? c : (c as { name?: unknown })?.name)).filter((s): s is string => typeof s === 'string') : []);
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
