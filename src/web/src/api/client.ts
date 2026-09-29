import type {
  Comment,
  CommentAuthor,
  CommentStatus,
  CommentSide,
} from '../../../core/comment-types.js';
import type {
  ActivityState,
  AnswerRequest,
  PermissionRequest,
  ChecksState,
  DevServerState,
  DiffStat,
  MergeMethod,
  NotifyEvent,
  PresenceReport,
  PtyStatus,
  RepoShipState,
  RevertRequest,
  RevertResponse,
  SessionAttention,
  SessionCi,
  SessionOverlap,
  ShipAction,
  ShipPr,
  ShipPreflight,
  ShipRequest,
  ShipResponse,
  ShipResult,
} from '../../../core/api-types.js';
import type { FileStatus, Hunk, HunkLine, LineKind, MarkdownContent, ParsedFile } from '../../../core/diff-parse.js';

// Wire types have ONE definition, in core (shared with the server) — see
// core/api-types.ts and core/diff-parse.ts. Re-exported here so SPA code
// keeps importing from api/client.
export type {
  ActivityState,
  AnswerRequest,
  PermissionRequest,
  ChecksState,
  DevServerState,
  DiffStat,
  MergeMethod,
  NotifyEvent,
  PresenceReport,
  PtyStatus,
  RepoShipState,
  RevertRequest,
  RevertResponse,
  SessionAttention,
  SessionCi,
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

export function setArchived(sessionId: string, archived: boolean): Promise<{ ok: true }> {
  return postJson(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, { archived });
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
export function fetchScopeDiff(
  base: DiffBase = 'uncommitted',
): Promise<ScopeDiffResult> {
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
  return getJson<ScopeDiffResult>(
    `/api/scopes/${encodeURIComponent(hash)}/diff${q ? `?${q}` : ''}`,
  );
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
  const base = hash
    ? `/api/scopes/${encodeURIComponent(hash)}/file-lines`
    : '/api/file-lines';
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
  return getJson<{ entries: CheckpointEntry[] }>(
    `/api/scopes/${encodeURIComponent(hash)}/checkpoints`,
  ).then((r) => r.entries);
}

/** Lazily generate (or return the cached) one-line Claude summary of what
 *  changed at a checkpoint. The server caches it in the manifest `label`. */
export function fetchCheckpointSummary(
  hash: string,
  id: number,
): Promise<{ label: string }> {
  return postJson<{ label: string }>(
    `/api/scopes/${encodeURIComponent(hash)}/checkpoints/${id}/summary`,
    {},
  );
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
  const q = range
    ? `?from=${range.from}&to=${range.to}`
    : base === 'branch'
      ? '?base=branch'
      : '';
  return getJson<SessionDiff>(
    `/api/sessions/${encodeURIComponent(sessionId)}/diff${q}`,
  );
}

/** A session's checkpoint history: one step per Claude instruction, taken
 *  when its turn ends (the first entry is the baseline). */
export function fetchSessionCheckpoints(sessionId: string): Promise<CheckpointEntry[]> {
  return getJson<{ entries: CheckpointEntry[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
  ).then((r) => r.entries);
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
