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
    execFile(cmd, args, { encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

/** Check if `acli` is available and authenticated. */
export async function isAcliAvailable(): Promise<boolean> {
  try {
    await execAsync('acli', ['jira', 'auth', 'status'], 5000);
    return true;
  } catch {
    return false;
  }
}


async function getJiraSiteUrl(): Promise<string> {
  try {
    const stdout = await execAsync('acli', ['jira', 'auth', 'status'], 5000);
    const match = stdout.match(/Site:\s+(\S+)/);
    return match ? `https://${match[1]}` : '';
  } catch {
    return '';
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

/**
 * Fetch Jira issues assigned to the current user.
 */
export async function fetchMyJiraIssues(): Promise<JiraIssue[]> {
  try {
    const [stdout, siteUrl] = await Promise.all([
      execAsync(
        'acli',
        [
          'jira', 'workitem', 'search',
          '--jql', 'assignee = currentUser() AND resolution = Unresolved AND status NOT IN (Archived, Done) ORDER BY updated DESC',
          '--json',
          '--limit', '50',
        ],
        15000,
      ),
      getJiraSiteUrl(),
    ]);
    if (!stdout) return [];
    return parseIssuesJson(stdout, siteUrl);
  } catch {
    return [];
  }
}
