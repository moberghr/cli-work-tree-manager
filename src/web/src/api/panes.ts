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
  /** Jira's status category (new / indeterminate / done): the board's column order. */
  statusCategory?: 'new' | 'indeterminate' | 'done';
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
  /** Repo aliases whose open PRs couldn't all be listed. */
  incomplete?: string[];
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

// ---- the Jira watch ------------------------------------------------------------

export type { JiraDecision, JiraWatchState } from '../../../core/api-types.js';
import type { JiraWatchState } from '../../../core/api-types.js';

/** The server's error text, from a JSON `{error}` body when there is one. */
function reason(err: unknown): Error {
  const msg = (err as Error).message;
  try {
    const parsed = JSON.parse(msg) as { error?: unknown };
    if (typeof parsed.error === 'string') return new Error(parsed.error);
  } catch {
    /* not JSON */
  }
  return err as Error;
}

export function fetchJiraWatch(): Promise<JiraWatchState> {
  return getJson('/api/jira/watch');
}

export function setJiraWatch(enabled: boolean): Promise<{ settings: JiraWatchState['settings'] }> {
  return postJson<{ settings: JiraWatchState['settings'] }>('/api/jira/watch', { enabled }, 'PUT').catch((e) => Promise.reject(reason(e)));
}

export function startJiraIssue(key: string, target: string): Promise<{ ok: true; sessionId: string }> {
  return postJson<{ ok: true; sessionId: string }>(`/api/jira/watch/${encodeURIComponent(key)}/start`, { target }).catch((e) => Promise.reject(reason(e)));
}

export function dismissJiraIssue(key: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/jira/watch/${encodeURIComponent(key)}/dismiss`, {}).catch((e) => Promise.reject(reason(e)));
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
  /** Start Claude with this as its first message. */
  prompt?: string;
  /** A name for the session, shown instead of the branch. */
  name?: string;
}

export interface CreateWorktreeResponse {
  sessionId: string;
  launchDir: string;
  paths: string[];
  /** With a prompt: Claude started with it, or (already running) it was
   *  queued for its next turn. */
  started?: 'started' | 'queued';
  /** With a prompt: why Claude could not be started. */
  startError?: string;
}

export function createWorktree(
  req: CreateWorktreeRequest,
): Promise<CreateWorktreeResponse> {
  return postJson('/api/worktrees', req);
}

export interface RemoveWorktreeOptions {
  /** Discard uncommitted changes / unpushed commits. */
  force?: boolean;
  /** Only forget the session; leave the worktree on disk. */
  sessionOnly?: boolean;
}

/**
 * Delete a session (and its worktree). Already gone — deleted a moment ago
 * from another window, or by the bulk bar while its row's own Delete was
 * asked — counts as deleted: that's what was wanted.
 */
export async function removeWorktree(
  sessionId: string,
  opts: RemoveWorktreeOptions = {},
): Promise<{ ok: true; worktreeRemoved: boolean; alreadyGone?: true }> {
  try {
    return await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/worktree`, opts, 'DELETE');
  } catch (err) {
    if (err instanceof Error && /"error"\s*:\s*"unknown session"/.test(err.message)) return { ok: true, worktreeRemoved: false, alreadyGone: true };
    throw err;
  }
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

export function openInTerminal(sessionId: string): Promise<{ ok: true }> {
  return postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/open-terminal`,
    {},
  );
}

export function openInEditor(
  sessionId: string,
): Promise<{ ok: true; opened: string }> {
  return postJson(
    `/api/sessions/${encodeURIComponent(sessionId)}/open-editor`,
    {},
  );
}
