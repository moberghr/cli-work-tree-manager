import type {
  Comment,
  CommentAuthor,
  CommentStatus,
  CommentSide,
} from '../../../core/comment-types.js';
export type { Comment, CommentAuthor, CommentStatus, CommentSide };

export type PtyStatus = 'running' | 'idle';
export type ActivityState = 'active' | 'open' | 'stale';
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
  /** Line-coverage percent (from lcov); undefined when no lcov data. */
  coverage?: number;
  /** Epoch-ms mtime of the lcov.info `coverage` came from; undefined when no
   *  lcov data. Surfaced in the badge tooltip so coverage age is visible. */
  coverageMtimeMs?: number;
  /** True when the file's source is newer than the lcov.info — coverage is
   *  stale and the badge is suppressed / de-emphasized. */
  coverageStale?: boolean;
  /** Full file contents for `.md` / `.markdown` / `.mdx` files — populated
   *  server-side so the SPA can render a Preview/Split view next to the
   *  diff. Absent for non-markdown files. */
  mdContent?: MarkdownContent;
}

export interface MarkdownContent {
  before?: string;
  after?: string;
  /** Server-side flag: either side exceeded the size cap, so the SPA
   *  must hide Preview/Split (rendering would blow the browser heap). */
  tooLarge?: boolean;
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
): Promise<SessionDiff> {
  const q = base === 'branch' ? '?base=branch' : '';
  return getJson<SessionDiff>(
    `/api/sessions/${encodeURIComponent(sessionId)}/diff${q}`,
  );
}
