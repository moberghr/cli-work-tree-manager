export interface SessionSummary {
  id: string;
  target: string;
  branch: string;
  isGroup: boolean;
  paths: string[];
  baseBranch?: string;
  jiraKey?: string;
  createdAt: string;
  lastAccessedAt: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchSessions(): Promise<SessionSummary[]> {
  return getJson<{ sessions: SessionSummary[] }>('/api/sessions').then(
    (r) => r.sessions,
  );
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';
export type LineKind = 'context' | 'add' | 'delete' | 'no-newline';

export interface HunkLine {
  kind: LineKind;
  content: string;
  oldNum: number | null;
  newNum: number | null;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  context: string;
  lines: HunkLine[];
}

export interface ParsedFile {
  path: string;
  oldPath: string;
  newPath: string;
  status: FileStatus;
  isBinary: boolean;
  added: number;
  deleted: number;
  hunks: Hunk[];
}

export interface RepoData {
  name: string;
  root: string;
  files: ParsedFile[];
}

export interface SessionDiff {
  sessionId: string;
  repos: RepoData[];
}

export function fetchSessionDiff(sessionId: string): Promise<SessionDiff> {
  return getJson<SessionDiff>(
    `/api/sessions/${encodeURIComponent(sessionId)}/diff`,
  );
}
