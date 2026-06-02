/**
 * Client-side wrappers for the PRs / Jira / Tasks / Projects / Worktree
 * mutation endpoints. Mirrors the server's surface in `panes-routes.ts`
 * and `worktree-routes.ts`.
 */

export interface ProjectSummary {
  name: string;
  kind: 'single' | 'group';
  path?: string;
  members?: string[];
}

export interface PrInfo {
  number: number;
  title: string;
  branch: string;
  url: string;
  isDraft: boolean;
  checksStatus: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
  reviewDecision:
    | 'APPROVED'
    | 'CHANGES_REQUESTED'
    | 'REVIEW_REQUIRED'
    | 'NONE';
  myReview: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'NONE';
  isMine: boolean;
  repoAlias: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  issuetype: string;
  priority: string;
  url: string;
}

export interface TaskItem {
  id: number;
  text: string;
  done: boolean;
  createdAt: string;
  doneAt?: string;
  link?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${path}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(
  path: string,
  body: unknown,
  method = 'POST',
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(txt || `${res.status} ${res.statusText} for ${path}`);
  }
  return res.json() as Promise<T>;
}

export function fetchProjects(): Promise<{
  singles: ProjectSummary[];
  groups: ProjectSummary[];
}> {
  return getJson('/api/projects');
}

export function fetchPrs(): Promise<{
  prs: PrInfo[];
  error?: string;
  available?: boolean;
}> {
  return getJson('/api/prs');
}

export function fetchJira(): Promise<{
  issues: JiraIssue[];
  available?: boolean;
  error?: string;
}> {
  return getJson('/api/jira');
}

export function fetchTasks(): Promise<{ tasks: TaskItem[] }> {
  return getJson('/api/tasks');
}

export function createTask(
  text: string,
  link?: string,
): Promise<{ task: TaskItem; tasks: TaskItem[] }> {
  return postJson('/api/tasks', { text, link });
}

export function updateTask(
  id: number,
  patch: { text?: string; done?: boolean },
): Promise<{ task: TaskItem; tasks: TaskItem[] }> {
  return postJson(`/api/tasks/${id}`, patch, 'PATCH');
}

export function deleteTask(id: number): Promise<{ tasks: TaskItem[] }> {
  return postJson(`/api/tasks/${id}`, {}, 'DELETE');
}

export interface CreateWorktreeRequest {
  target: string;
  branch: string;
  base?: string;
  jiraKey?: string;
}

export interface CreateWorktreeResponse {
  sessionId: string;
  launchDir: string;
  paths: string[];
}

export function createWorktree(
  req: CreateWorktreeRequest,
): Promise<CreateWorktreeResponse> {
  return postJson('/api/worktrees', req);
}

export function removeWorktree(
  sessionId: string,
  force: boolean,
): Promise<{ ok: true }> {
  return postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/worktree`,
    { force },
    'DELETE',
  );
}

export interface SyncResult {
  path: string;
  fetched: boolean;
  pulled: boolean;
  pullError?: string;
}

export function syncWorktree(
  sessionId: string,
): Promise<{ results: SyncResult[] }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/sync`, {});
}

export interface RebaseResult {
  path: string;
  ok: boolean;
  parent?: string;
  error?: string;
}

export function rebaseWorktree(
  sessionId: string,
): Promise<{ results: RebaseResult[] }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/rebase`, {});
}

export function openInEditor(
  sessionId: string,
): Promise<{ ok: true; opened: string }> {
  return postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/open-editor`,
    {},
  );
}
