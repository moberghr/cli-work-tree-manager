import type { Comment, CommentAuthor, CommentStatus, CommentSide } from '../../../core/comments/comment-types.js';
import type { UpdateFromMainWire } from '../../../core/api-types.js';
import type { SnoozeChoice } from '../../../core/rail/snooze.js';
import { trackArchive } from './archive-pending.js';
import type {
  ActivityState,
  AnswerRequest,
  AssistantView,
  PermissionRequest,
  ChecksState,
  CleanupAction,
  CleanupCandidate,
  CleanupState,
  ContextUsage,
  DevServerState,
  DigestResponse,
  DigestSession,
  DiffStat,
  MergeMethod,
  NotifyEvent,
  PresenceReport,
  PromptsResponse,
  PtyStatus,
  RepoShipState,
  RevertRequest,
  RevertResponse,
  SavedPrompt,
  SessionAttention,
  SessionCi,
  ConversationHit,
  SessionArchiveInfo,
  SessionClaudes,
  SessionOverlap,
  ShipAction,
  ShipPr,
  ShipPreflight,
  ShipRequest,
  ShipResponse,
  ShipResult,
} from '../../../core/api-types.js';
import type { FileStatus, Hunk, HunkLine, LineKind, MarkdownContent, ParsedFile } from '../../../core/diff/diff-parse.js';

// Wire types have ONE definition, in core (shared with the server) — see
// core/api-types.ts and core/diff-parse.ts. Re-exported here so SPA code
// keeps importing from api/client.
export type {
  ActivityState,
  AnswerRequest,
  AssistantView,
  PermissionRequest,
  ChecksState,
  CleanupAction,
  CleanupCandidate,
  CleanupState,
  ContextUsage,
  DevServerState,
  DigestResponse,
  DigestSession,
  DiffStat,
  MergeMethod,
  NotifyEvent,
  PresenceReport,
  PromptsResponse,
  PtyStatus,
  RepoShipState,
  RevertRequest,
  RevertResponse,
  SavedPrompt,
  SessionAttention,
  SessionCi,
  ConversationHit,
  SessionArchiveInfo,
  SessionClaudes,
  SessionOverlap,
  ShipAction,
  ShipPr,
  ShipPreflight,
  ShipRequest,
  ShipResponse,
  ShipResult,
};
export type { FileStatus, Hunk, HunkLine, LineKind, MarkdownContent, ParsedFile };
export type { Comment, CommentAuthor, CommentStatus, CommentSide };

export type DiffBase = 'uncommitted' | 'branch';

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
  /** Dashboard-only; absent when fetching from the wd -c review server. */
  draftCount?: number;
  commentCount?: number;
  claudeCount?: number;
  /** True when *our* `work web` PTY pool spawned a Claude for this session. */
  ptyStatus?: PtyStatus;
  /** ms-since-epoch of Claude's most recent transcript write for this
   *  worktree — picks up any Claude on the box, not just our pool. */
  lastActivity?: number | null;
  /** Decayed: ≤30 s = 'active', ≤5 min = 'open', else 'stale'. */
  activityState?: ActivityState;
  /** Published user comments not yet surfaced to Claude. Drops to zero
   *  once the UserPromptSubmit hook fires inside a live Claude here. */
  pendingForClaudeCount?: number;
  /** Hook-driven agent status (attention inbox); null/absent until the
   *  session's Claude fires a hook under a full `work web`. */
  attention?: SessionAttention | null;
  /** Working-tree change vs HEAD across the session's repos (tracked
   *  numstat + untracked files). Null until computed — the server fills it
   *  in the background and caches it briefly, so it may lag a few seconds. */
  diffStat?: DiffStat | null;
  /** Set when the session was archived: PTY stopped, worktree + branch +
   *  conversation kept, hidden from the rail/inbox by default. */
  archivedAt?: string | null;
  /** Other live sessions changing some of the same files (merge conflict
   *  ahead); absent when none. */
  overlaps?: SessionOverlap[];
  /** Claudes running for it right now, wherever they were started. */
  /** Its agent processes running right now (the same as `claudes`, the old name). */
  agents?: SessionClaudes;
  claudes?: SessionClaudes;
  /** The agent it runs, and what work can do with it. */
  agent?: import('../../../core/api-types.js').SessionAgentWire;
  /** What its archive kept (archived sessions). */
  archive?: SessionArchiveInfo;
  /** Its name: yours, else its first prompt, else its Jira key. */
  title?: string | null;
  /** Snoozed out of the Inbox right now: until when, or null for "until it changes". */
  snoozed?: { until: string | null };
  /** Behind its main branch, as of the last fetch (absent when level). */
  behind?: { base: string; commits: number; conflicts: boolean; stacked?: true };
  /** The live session it is stacked on (stack.ts). */
  stackedOn?: { id: string; branch: string; title?: string };
  /** How many live sessions are stacked on this one. */
  stackedChildren?: number;
  /** You have notes on it. */
  hasNote?: boolean;
  /** What it waits on that isn't done yet: out of the Inbox meanwhile. */
  blockedBy?: import('../../../core/api-types.js').BlockerWire[];
  /** It was stacked on a session that merged and is archived: it should move onto main. */
  stackParentMerged?: { id: string; branch: string };
  /** Repos checked out on another branch than `branch` (null = detached). */
  onOtherBranch?: Array<{ repo: string; branch: string | null }>;
  titleIsYours?: boolean;
  /** How full its Claude conversation is; null before the first reply. */
  context?: ContextUsage | null;
  /** Unresolved review threads on its open PRs, waiting on you. */
  openReviewThreads?: number;
  /** Replies its Claude drafted on those threads, for you to post. */
  replyDrafts?: number;
}

// ---- Ship / archive ---------------------------------------------------

export function fetchShipPreflight(sessionId: string): Promise<ShipPreflight> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/ship`);
}

/** push: publish the branch. create-pr: push if needed, then open a PR
 *  (draft optional). merge: merge exactly `repos`, each at the PR head the
 *  user was shown (refused if it moved; all validated before any merges);
 *  the session is archived only when every repo is done afterwards. */
export function ship(sessionId: string, body: ShipRequest): Promise<ShipResponse> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/ship`, body);
}

/**
 * Archive or restore. When something is still waiting in the session
 * (replies to post, notes for its Claude, a Claude mid-turn), the server
 * says what; `confirm` asks whether to archive anyway (the browser's own
 * dialog by default). Declined: rejects with what was waiting.
 */
export function setArchived(
  sessionId: string,
  archived: boolean,
  confirm: (question: string) => boolean = (q) => window.confirm(q),
): Promise<{ ok: true }> {
  // Every caller's button shows it running, wherever you come back to it.
  return trackArchive(sessionId, archived, sendArchived(sessionId, archived, confirm));
}

async function sendArchived(sessionId: string, archived: boolean, confirm: (question: string) => boolean): Promise<{ ok: true }> {
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/archive`;
  const send = (force: boolean) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived, ...(force ? { force: true } : {}) }),
    });
  let res = await send(false);
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { blocked?: string[]; error?: string };
    const waiting = body.blocked ?? [];
    if (!confirm(`Still waiting in this session:\n\n• ${waiting.join('\n• ')}\n\nArchive it anyway?`)) {
      throw new Error(`Not archived: ${waiting.join('; ')}`);
    }
    res = await send(true);
  }
  const json = (await res.json().catch(() => ({}))) as { ok?: true; error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} for ${url}`);
  return { ok: true };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${path}`);
  }
  return res.json() as Promise<T>;
}

type PrReply = import('../../../core/api-types.js').PrReply;

/** Review threads handed to the session's Claude, and the replies it drafted. */
export function fetchReplies(sessionId: string): Promise<import('../../../core/api-types.js').RepliesWire> {
  return getJson<import('../../../core/api-types.js').RepliesWire>(`/api/sessions/${encodeURIComponent(sessionId)}/replies`).then((r) => ({
    replies: r.replies,
    waiting: r.waiting ?? [],
  }));
}

async function sendJson<T>(method: 'PUT' | 'DELETE' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${res.status} for ${path}`);
  return json;
}

const replyPath = (sessionId: string, threadId: string) =>
  `/api/sessions/${encodeURIComponent(sessionId)}/replies/${encodeURIComponent(threadId)}`;

export function editReply(sessionId: string, threadId: string, body: string): Promise<{ reply: PrReply }> {
  return sendJson('PUT', replyPath(sessionId, threadId), { body });
}

export function discardReply(sessionId: string, threadId: string): Promise<{ ok: boolean }> {
  return sendJson('DELETE', replyPath(sessionId, threadId));
}

/** Post the reply from your GitHub account; `resolve` also resolves the thread. */
export function postReply(
  sessionId: string,
  threadId: string,
  body: string,
  resolve: boolean,
): Promise<{ ok: true; url: string; resolved: boolean }> {
  return sendJson('POST', `${replyPath(sessionId, threadId)}/post`, { body, resolve });
}

/** What work is doing in the background, and what it decided (the Activity panel). */
export function fetchActivity(): Promise<import('../../../core/api-types.js').ActivityWire> {
  return getJson('/api/activity');
}

export function fetchSessions(): Promise<SessionSummary[]> {
  return getJson<{ sessions: SessionSummary[] }>('/api/sessions').then((r) => r.sessions);
}

export interface ReviewContext {
  mode: 'review';
  scopeLabel: string;
  repos: { name: string }[];
  /** Current branch of the primary repo (`git rev-parse --abbrev-ref HEAD`).
   *  Drives the "<headBranch> vs <base>" comparison title. Undefined in
   *  detached-HEAD state or when not resolvable. */
  headBranch?: string;
  /** When true, the comment UI is hidden — the SPA still renders the
   *  diff with live updates, but the user can't post / draft / submit. */
  readOnly?: boolean;
  /** True when the SPA is hydrated from inlined boot data (no server).
   *  Used to suppress SSE attempts and live-only UI affordances. */
  staticMode?: boolean;
  /** Initial diff scope to display. Honors `wd --branch`. The user can
   *  toggle to the other scope in-browser. */
  initialBase?: DiffBase;
}

interface StaticBoot {
  context: ReviewContext;
  /** New shape: both scopes pre-computed when both are available. */
  diffs?: {
    uncommitted: ScopeDiff;
    branch?: ScopeDiff;
  };
  /** Legacy single-scope payload. Always written for backward compat. */
  diff: ScopeDiff;
}

interface ScopeDiff {
  repos: RepoData[];
  /** Echoed by `/api/diff` and inlined by renderStatic: `HEAD` for
   *  uncommitted, the actual branch name (e.g. `origin/main`) for
   *  branch mode. */
  resolvedBase?: string;
}

/** Returns the boot payload when the page was opened as a static file
 *  rather than served by `wd -c` / `work web`. */
function getBoot(): StaticBoot | null {
  const w = window as unknown as { __WD_BOOT__?: StaticBoot };
  return w.__WD_BOOT__ ?? null;
}

export function isStaticMode(): boolean {
  return getBoot() !== null;
}
export interface DashboardContext {
  mode: 'dashboard';
}
export type AppContext = ReviewContext | DashboardContext;

export function fetchContext(): Promise<AppContext> {
  const boot = getBoot();
  if (boot) return Promise.resolve(boot.context);
  return getJson<AppContext>('/api/context');
}

export interface ScopeDiffResult {
  repos: RepoData[];
  resolvedBase?: string;
  /** Current branch of the primary repo. Surfaced here (not just in
   *  ReviewContext) because work-web scope views synthesize their context
   *  from the URL hash and read the branch off the diff instead. */
  headBranch?: string;
}

/**
 * Fetch the diff for the current scope and base. Static mode reads from
 * the inlined boot (covers both bases when present); server mode hits
 * `/api/diff?base=…`.
 *
 * Returns the boot's legacy `diff` when the boot doesn't carry the new
 * `diffs.<base>` shape — keeps old static HTML from earlier `wd` builds
 * working until the user regenerates.
 */
export function fetchScopeDiff(base: DiffBase = 'uncommitted'): Promise<ScopeDiffResult> {
  const boot = getBoot();
  if (boot) {
    if (boot.diffs?.[base]) return Promise.resolve(boot.diffs[base]!);
    return Promise.resolve(boot.diff);
  }
  const q = base === 'branch' ? '?base=branch' : '';
  return getJson<ScopeDiffResult>(`/api/diff${q}`);
}

/** Reports which scopes have data inlined. Used to decide whether to
 *  show the "Since branch" toggle in static mode — if the renderer
 *  couldn't find a parent, the toggle won't help. */
export function staticHasBranchScope(): boolean {
  return !!getBoot()?.diffs?.branch;
}

/** Endpoint of a checkpoint range. `'working'` is the live working tree
 *  (only valid on the `to` side); numbers are checkpoint ids. */
export type CheckpointRangeEnd = number | 'working';

/**
 * Fetch a diff for a registered scope from the shared `work web` server.
 * Used by URLs like `/diff/<hash>` and `/review/<hash>` where the SPA is
 * served by `work web` and a `wd` invocation has registered the scope.
 *
 * When `range` is provided, the server resolves each endpoint to the
 * commit captured at that checkpoint and returns a diff between them
 * (instead of the default HEAD-vs-working). The `base` parameter is
 * ignored in range mode.
 */
export function fetchScopeDiffByHash(
  hash: string,
  base: DiffBase = 'uncommitted',
  range?: { from: number; to: CheckpointRangeEnd },
): Promise<ScopeDiffResult> {
  const params = new URLSearchParams();
  if (range) {
    params.set('from', String(range.from));
    params.set('to', String(range.to));
  } else if (base === 'branch') {
    params.set('base', 'branch');
  }
  const q = params.toString();
  return getJson<ScopeDiffResult>(`/api/scopes/${encodeURIComponent(hash)}/diff${q ? `?${q}` : ''}`);
}

export interface FileLinesResult {
  /** Requested slice (may be shorter than asked when the file ends first). */
  lines: string[];
  /** Echoed 1-based first line of `lines`. */
  start: number;
  /** Total line count of the file at this ref. */
  totalLines: number;
  /** True when there is nothing further below to expand. */
  eof: boolean;
}

/** Fetch a range of file lines to reveal unchanged context around a hunk.
 *  `hash` selects the scope-mounted endpoint (`work web`); pass undefined
 *  for the standalone diff-server route. `ref` is omitted for the common
 *  working-tree case. */
export function fetchFileLines(
  hash: string | undefined,
  repo: string,
  filePath: string,
  start: number,
  end: number,
  ref?: string,
): Promise<FileLinesResult> {
  const params = new URLSearchParams({
    repo,
    path: filePath,
    start: String(start),
    end: String(end),
  });
  if (ref) params.set('ref', ref);
  const base = hash ? `/api/scopes/${encodeURIComponent(hash)}/file-lines` : '/api/file-lines';
  return getJson<FileLinesResult>(`${base}?${params.toString()}`);
}

export interface CheckpointEntry {
  id: number;
  ts: string;
  label?: string;
  /** Per-repo commit sha (null when the repo had no HEAD at capture
   *  time — diffs treat that side as the empty tree). */
  repos: Record<string, string | null>;
}

export function fetchCheckpoints(hash: string): Promise<CheckpointEntry[]> {
  return getJson<{ entries: CheckpointEntry[] }>(`/api/scopes/${encodeURIComponent(hash)}/checkpoints`).then((r) => r.entries);
}

/** Lazily generate (or return the cached) one-line Claude summary of what
 *  changed at a checkpoint. The server caches it in the manifest `label`. */
export function fetchCheckpointSummary(hash: string, id: number): Promise<{ label: string }> {
  return postJson<{ label: string }>(`/api/scopes/${encodeURIComponent(hash)}/checkpoints/${id}/summary`, {});
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
  const res = await fetch(`/api/comments/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

export interface RepoData {
  name: string;
  root: string;
  files: ParsedFile[];
  /** Per-repo parent branch the diff was computed against. Present on
   *  scope and session diffs from `work web`; absent on static boot. For
   *  group worktrees, sub-repos may have different parents — UI labels
   *  can show this value rather than the top-level `resolvedBase`
   *  (which is just the primary repo's value, for the sidebar header). */
  resolvedBase?: string;
}

export interface SessionDiff {
  sessionId: string;
  /** Which scope was requested. */
  base?: DiffBase;
  /** The actual ref the diff is against — `HEAD` for uncommitted,
   *  or the resolved parent branch (e.g. `dev`, `origin/main`) for
   *  branch mode. UI uses this for labelling. */
  resolvedBase?: string;
  repos: RepoData[];
}

export function fetchSessionDiff(
  sessionId: string,
  base: DiffBase = 'uncommitted',
  range?: { from: number; to: number },
): Promise<SessionDiff> {
  const q = range ? `?from=${range.from}&to=${range.to}` : base === 'branch' ? '?base=branch' : '';
  return getJson<SessionDiff>(`/api/sessions/${encodeURIComponent(sessionId)}/diff${q}`);
}

/** A session's checkpoint history: one step per Claude instruction, taken
 *  when its turn ends (the first entry is the baseline). */
export function fetchSessionCheckpoints(sessionId: string): Promise<CheckpointEntry[]> {
  return getJson<{ entries: CheckpointEntry[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`).then((r) => r.entries);
}

/** Consecutive checkpoint pairs = turns, newest first. */
export interface TurnRange {
  from: number;
  to: number;
  /** 1-based turn number. */
  n: number;
  label?: string;
  ts: string;
}
export function turnsFrom(entries: CheckpointEntry[]): TurnRange[] {
  const out: TurnRange[] = [];
  for (let i = 1; i < entries.length; i++) {
    out.push({ from: entries[i - 1].id, to: entries[i].id, n: i, label: entries[i].label, ts: entries[i].ts });
  }
  return out.reverse();
}

/** What the dashboard shows, for the Ctrl+K assistant's context. */
export function reportAssistantView(view: AssistantView): Promise<{ ok: true }> {
  return postJson('/api/assistant/context', view);
}

/** Out of the Inbox for 2 hours, until tomorrow 9:00, or until its status changes (snooze.ts). */
export function snoozeSession(s: Pick<SessionSummary, 'id' | 'openReviewThreads'>, choice: SnoozeChoice): Promise<{ ok: true }> {
  const what = typeof choice === 'string' ? { for: choice } : { until: choice.until };
  return postJson(`/api/sessions/${encodeURIComponent(s.id)}/snooze`, { ...what, openReviewThreads: s.openReviewThreads ?? 0 });
}

export async function unsnoozeSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/snooze`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status} unsnoozing`);
}

/** A prompt for a session's Claude, sent like a review comment: pushed into a
 *  terminal the dashboard owns, or delivered on its next turn — never typed
 *  over a prompt. (Prompts ▾, the bulk bar.) */
export async function sendPromptToSession(sessionId: string, body: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ side: 'general', status: 'published', body }),
  });
  if (!res.ok) throw new Error(`send failed (${res.status})`);
}

export type UpdateFromMainResult = UpdateFromMainWire['results'][number];

/** Fetch, then rebase (never pushed) or merge main in (pushed); conflicts aborted. One result per repo. */
/** A stacked session whose parent merged: onto main (only its own commits on top). */
export async function retargetSession(sessionId: string): Promise<UpdateFromMainResult[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/retarget`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Partial<UpdateFromMainWire> & { error?: string };
  if (!res.ok || !body.results) throw new Error(body.error ?? `moving onto main failed (${res.status})`);
  return body.results;
}

export async function updateFromMain(sessionId: string): Promise<UpdateFromMainResult[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/update-from-main`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as Partial<UpdateFromMainWire> & { error?: string };
  if (!res.ok || !body.results) throw new Error(body.error ?? `update failed (${res.status})`);
  return body.results;
}

/** "Catch me up": a few sentences on where a session stands (written once per conversation growth). */
export async function catchUpSession(sessionId: string): Promise<{ text: string; at: string }> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/catch-up`, { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { catchUp?: { text: string; at: string } | null; error?: string };
  if (!res.ok || !body.catchUp) throw new Error(body.error ?? `catching up failed (${res.status})`);
  return body.catchUp;
}

/** The user opened a session that wanted attention — clear its unseen flag. */
export function markSessionSeen(sessionId: string): Promise<{ ok: true }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/seen`, {});
}

/** Allow / Deny the permission prompt a session is blocked on. Throws with
 *  the server's reason when it refused to type (already answered, a
 *  different prompt on screen, not running in the PTY host). */
export async function answerPermission(sessionId: string, req: AnswerRequest): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `answer failed (${res.status})`);
  }
}

/** Name a session; an empty title goes back to the automatic name. */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`renaming failed (${res.status})`);
}

// ---- search in kept conversations (live and archived) -----------------------

export async function searchConversations(q: string): Promise<ConversationHit[]> {
  const r = await getJson<{ hits?: ConversationHit[] }>(`/api/conversations/search?q=${encodeURIComponent(q)}`);
  return r.hits ?? [];
}

// ---- the sessions list's manual order ---------------------------------------

export async function fetchSessionOrder(): Promise<string[]> {
  const r = await getJson<{ order?: unknown }>('/api/session-order');
  return Array.isArray(r.order) ? r.order.filter((x): x is string => typeof x === 'string') : [];
}

export async function saveSessionOrder(order: string[]): Promise<void> {
  const res = await fetch('/api/session-order', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  });
  if (!res.ok) throw new Error(`saving the order failed (${res.status})`);
}

// ---- the PTY host's heartbeat ----------------------------------------------

export function fetchHostHealth(): Promise<import('../../../core/pty/host-health.js').HostHealth> {
  return getJson('/api/pty-host/health');
}

// ---- a session's timeline ---------------------------------------------------

export async function fetchTimeline(sessionId: string): Promise<import('../../../core/conversations/timeline.js').TimelineEvent[]> {
  return (
    await getJson<{ events: import('../../../core/conversations/timeline.js').TimelineEvent[] }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/timeline`,
    )
  ).events;
}

// ---- blocked by ----------------------------------------------------------

/** Wait on another session (its id) or a pull request (its URL). */
export async function addBlocker(sessionId: string, ref: { kind: 'session'; id: string } | { kind: 'pr'; url: string }): Promise<void> {
  await sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/blocks`, ref);
}

/** Stop waiting on one thing (its key), or on everything. */
export async function removeBlocker(sessionId: string, key?: string): Promise<void> {
  await sendJson('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}/blocks${key ? `?key=${encodeURIComponent(key)}` : ''}`);
}

// ---- your notes on a session ----------------------------------------------

export async function fetchNote(sessionId: string): Promise<{ text: string; updatedAt: string } | null> {
  return (await getJson<{ note: { text: string; updatedAt: string } | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/note`)).note;
}

export async function saveNote(sessionId: string, text: string): Promise<void> {
  await sendJson('PUT', `/api/sessions/${encodeURIComponent(sessionId)}/note`, { text });
}

// ---- time per session ----------------------------------------------------

export type WorkTime = import('../../../core/api-types.js').WorkTimeWire;

/** How long the session's Claude worked (approximate; reads its transcripts). */
export function fetchWorkTime(sessionId: string): Promise<WorkTime> {
  return getJson<WorkTime>(`/api/sessions/${encodeURIComponent(sessionId)}/time`);
}

/** Can it write Jira worklogs, to which issue, what was logged per day. */
export function fetchWorklog(sessionId: string): Promise<import('../../../core/api-types.js').WorklogWire> {
  return getJson(`/api/sessions/${encodeURIComponent(sessionId)}/worklog`);
}

/** Log a day's work (default: the latest) to its Jira issue: what isn't logged yet. */
export function logWorklog(sessionId: string, day?: string): Promise<{ ok: true; logged: number; total: number; text: string }> {
  return sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/worklog`, day ? { day } : {});
}

// ---- fork a session ------------------------------------------------------

/** A new branch from where the session is; its Claude starts with a summary of this conversation. Slow (the summary). */
export function forkSession(
  sessionId: string,
  req: { branch: string; prompt?: string; name?: string },
): Promise<import('../../../core/api-types.js').ForkWire> {
  return sendJson('POST', `/api/sessions/${encodeURIComponent(sessionId)}/fork`, req);
}

// ---- the rail's pins and sections ----------------------------------------

type RailLayout = import('../../../core/rail/rail-layout.js').RailLayout;

export function fetchRailLayout(): Promise<RailLayout> {
  return getJson<RailLayout>('/api/rail');
}

/** One change to your sections, applied to the list as it is on the server. */
export function changeRailSections(op: import('../../../core/rail/rail-layout.js').SectionOp): Promise<RailLayout> {
  return sendJson('POST', '/api/rail/sections', op);
}

/** Pin / unpin, or move into (`section: id`) or out of (`null`) a section. */
export function placeSession(sessionId: string, patch: import('../../../core/rail/rail-layout.js').PlacePatch): Promise<RailLayout> {
  return sendJson('PUT', `/api/sessions/${encodeURIComponent(sessionId)}/rail`, patch);
}

/** Undo an uncommitted file or hunk and tell Claude. Throws with the
 *  server's reason (e.g. "the file changed since — reload the diff"). */
export async function revertChange(sessionId: string, req: RevertRequest): Promise<RevertResponse> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as RevertResponse;
}

/** The worktree's port + dev server. */
export function fetchDevState(sessionId: string): Promise<DevServerState> {
  return getJson<DevServerState>(`/api/sessions/${encodeURIComponent(sessionId)}/dev`);
}
/** Start / stop the configured dev command. Throws with the server's reason. */
export async function devAction(sessionId: string, action: 'start' | 'stop'): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/dev/${action}`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
}

/** What GitHub says about the session's PRs (from work web's PR watch). */
export function fetchSessionCi(sessionId: string): Promise<SessionCi> {
  return getJson<SessionCi>(`/api/sessions/${encodeURIComponent(sessionId)}/ci`);
}
/** Ask the session's Claude to fix its failing checks. */
export async function askClaudeToFixCi(sessionId: string): Promise<void> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ci/fix`, { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
}
