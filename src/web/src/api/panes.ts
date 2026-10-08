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
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE';
  myReview: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'NONE';
  isMine: boolean;
  /** It conflicts with its base (absent from a server before this). */
  conflicting?: boolean;
  /** Your review was asked for, by name. */
  reviewRequested?: boolean;
  repoAlias: string;
  /** Its author's login (absent from a server before this). */
  author?: string;
  /** It comes from a fork: its branch isn't on origin, so no one can work on it here. */
  fork?: boolean;
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

async function postJson<T>(path: string, body: unknown, method = 'POST'): Promise<T> {
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

/** Is a branch new for a project (branch-check.ts)? The New worktree dialog asks before it creates. */
export function fetchBranchCheck(target: string, branch: string): Promise<import('../../../core/api-types.js').BranchCheck> {
  return getJson(`/api/branch-check?target=${encodeURIComponent(target)}&branch=${encodeURIComponent(branch)}`);
}

/**
 * A PR to start a session on (GET /api/pr-start): its repo, branch, title and
 * author — or why not (a fork, closed, not one of your repos), as the server said.
 */
export async function lookupPr(ref: string, target?: string): Promise<PrToStart> {
  const q = `ref=${encodeURIComponent(ref)}${target ? `&target=${encodeURIComponent(target)}` : ''}`;
  const res = await fetch(`/api/pr-start?${q}`, { headers: { Accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as Partial<PrStartWire>;
  if (res.ok && 'pr' in body && body.pr) return body.pr;
  throw new Error('error' in body && body.error ? body.error : `${res.status} ${res.statusText}`);
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
  return postJson<{ ok: true; sessionId: string }>(`/api/jira/watch/${encodeURIComponent(key)}/start`, { target }).catch((e) =>
    Promise.reject(reason(e)),
  );
}

export function dismissJiraIssue(key: string): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/api/jira/watch/${encodeURIComponent(key)}/dismiss`, {}).catch((e) => Promise.reject(reason(e)));
}

export function fetchTasks(): Promise<{ tasks: TaskItem[] }> {
  return getJson('/api/tasks');
}

export function createTask(text: string, link?: string): Promise<{ task: TaskItem; tasks: TaskItem[] }> {
  return postJson('/api/tasks', { text, link });
}

export function updateTask(id: number, patch: { text?: string; done?: boolean }): Promise<{ task: TaskItem; tasks: TaskItem[] }> {
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

export function createWorktree(req: CreateWorktreeRequest): Promise<CreateWorktreeResponse> {
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
    if (err instanceof Error && /"error"\s*:\s*"unknown session"/.test(err.message))
      return { ok: true, worktreeRemoved: false, alreadyGone: true };
    throw err;
  }
}

export interface SyncResult {
  path: string;
  fetched: boolean;
  pulled: boolean;
  pullError?: string;
}

export function syncWorktree(sessionId: string): Promise<{ results: SyncResult[] }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/sync`, {});
}

export interface RebaseResult {
  path: string;
  ok: boolean;
  parent?: string;
  error?: string;
}

export function rebaseWorktree(sessionId: string): Promise<{ results: RebaseResult[] }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/rebase`, {});
}

export function openInTerminal(sessionId: string): Promise<{ ok: true }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/open-terminal`, {});
}

export function openInEditor(sessionId: string): Promise<{ ok: true; opened: string }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/open-editor`, {});
}

// ---- Repos and groups (the Repos page; repo-admin.ts) ----------------------

/** A refusal from the Repos routes; `sessions` names the live sessions a 409 could be forced past. */
export class RepoChangeError extends Error {
  constructor(
    message: string,
    readonly sessions: string[] = [],
  ) {
    super(message);
  }
}

async function repoCall(method: string, url: string, body?: unknown): Promise<void> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.ok) return;
  const b = (await res.json().catch(() => ({}))) as { error?: string; sessions?: string[] };
  throw new RepoChangeError(b.error ?? `${res.status} ${res.statusText}`, b.sessions ?? []);
}

export function fetchRepos(): Promise<import('../../../core/api-types.js').ReposWire> {
  return getJson('/api/repos');
}
export const enrollRepo = (alias: string, path: string) => repoCall('POST', '/api/repos', { alias, path });
export const removeRepo = (alias: string, force = false) =>
  repoCall('DELETE', `/api/repos/${encodeURIComponent(alias)}${force ? '?force=1' : ''}`);
export const ignoreRepo = (path: string, ignored: boolean) => repoCall('POST', '/api/repos/ignore', { path, ignored });
export const setScanRoot = (path: string, on: boolean) => repoCall('POST', '/api/repos/roots', { path, on });
export const saveGroup = (name: string, members: string[], creating: boolean) =>
  repoCall('POST', '/api/groups', { name, members, creating });
export const deleteGroup = (name: string, force = false) =>
  repoCall('DELETE', `/api/groups/${encodeURIComponent(name)}${force ? '?force=1' : ''}`);

// ---- first run (the Welcome page) ----

export function fetchSetup(fresh = false): Promise<import('../../../core/api-types.js').SetupWire> {
  return getJson(`/api/setup${fresh ? '?fresh=1' : ''}`);
}

/** Set where repos are and where worktrees go (config.json made when there is none). */
export async function saveSetupFolders(worktreesRoot: string, reposFolder: string): Promise<void> {
  const res = await fetch('/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ worktreesRoot, reposFolder }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `${res.status} saving folders`);
}

// ---- updates and release notes ----

type UpdateWire = import('../../../core/api-types.js').UpdateWire;
type ReleaseNote = import('../../../core/api-types.js').ReleaseNote;
type PrStartWire = import('../../../core/api-types.js').PrStartWire;
type PrToStart = import('../../../core/api-types.js').PrToStart;

export function fetchUpdates(): Promise<UpdateWire> {
  return getJson('/api/updates');
}

async function postUpdates<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const b = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(b.error ?? `${res.status} ${res.statusText}`);
  return b;
}

/** Check for updates now: the release list, and the desktop app's updater. */
export const checkForUpdates = () => postUpdates<UpdateWire>('/api/updates/check');
/** Restart the desktop app into the update it downloaded. */
export const restartToUpdate = () => postUpdates<{ ok: true }>('/api/updates/restart');
export const markNotesSeen = (version: string) => postUpdates<{ ok: true }>('/api/updates/seen', { version });
export function fetchReleaseNotes(): Promise<{ releases: ReleaseNote[]; checkError: string | null }> {
  return getJson('/api/updates/notes');
}
