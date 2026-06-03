import { execFile } from 'node:child_process';

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
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

/** Check if `acli` is available and authenticated. Kept for the TUI's
 *  pre-flight; the web pane uses fetchMyJiraIssues directly which short-
 *  circuits on auth failure too. */
export async function isAcliAvailable(): Promise<boolean> {
  try {
    await execAsync('acli', ['jira', 'auth', 'status'], 5000);
    return true;
  } catch {
    return false;
  }
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
 * Fetch Jira issues assigned to the current user.
 *
 * Backwards-compatible signature for the TUI — returns an empty array
 * when acli is unavailable or errors. Web callers that need to
 * distinguish unavailable from empty should use `fetchJiraPane()`.
 */
export async function fetchMyJiraIssues(): Promise<JiraIssue[]> {
  const probe = await probeAcli();
  if (!probe.available) return [];
  return searchMyIssues(probe.siteUrl);
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
