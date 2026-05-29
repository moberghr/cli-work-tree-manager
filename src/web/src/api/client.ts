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

export interface ReviewContext {
  mode: 'review';
  scopeLabel: string;
  repos: { name: string }[];
}
export interface DashboardContext {
  mode: 'dashboard';
}
export type AppContext = ReviewContext | DashboardContext;

export function fetchContext(): Promise<AppContext> {
  return getJson<AppContext>('/api/context');
}

export function fetchScopeDiff(): Promise<{ repos: RepoData[] }> {
  return getJson<{ repos: RepoData[] }>('/api/diff');
}

export type CommentAuthor = 'user' | 'claude';
export type CommentStatus = 'published' | 'draft';
export type CommentSide = 'left' | 'right' | 'general';

export interface Comment {
  id: string;
  repo: string;
  file: string;
  line: number;
  side: CommentSide;
  body: string;
  createdAt: string;
  lineContent?: string;
  author: CommentAuthor;
  parentId?: string;
  status: CommentStatus;
}

export interface CommentInput {
  repo?: string;
  file?: string;
  line?: number;
  side?: CommentSide;
  body: string;
  status?: CommentStatus;
  lineContent?: string;
  parentId?: string;
  author?: CommentAuthor;
}

async function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

export function fetchComments(): Promise<Comment[]> {
  return getJson<{ comments: Comment[] }>('/api/comments').then((r) => r.comments);
}

export function postComment(input: CommentInput): Promise<{ comments: Comment[] }> {
  return postJson<{ comments: Comment[] }>('/api/comments', input);
}

export async function deleteComment(id: string): Promise<{ comments: Comment[] }> {
  const res = await fetch(
    `/api/comments/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<{ comments: Comment[] }>;
}

export function submitReview(summary: string): Promise<{ comments: Comment[]; count: number }> {
  return postJson<{ comments: Comment[]; count: number }>('/api/submit-review', { summary });
}

export function discardReview(): Promise<{ comments: Comment[]; discarded: number }> {
  return postJson<{ comments: Comment[]; discarded: number }>('/api/discard-review', {});
}

export function postDone(): Promise<{ ok: boolean; count: number }> {
  return postJson<{ ok: boolean; count: number }>('/api/done', {});
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
