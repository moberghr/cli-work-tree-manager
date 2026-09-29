import type { AttentionLike } from './attention.js';

/**
 * Wire types shared by the server (core) and the browser SPA — ONE
 * definition each, so the two can't drift (they did: fields added on one
 * side had to be remembered on the other). Types only, no runtime imports:
 * the SPA imports this file directly (architecture allowlist), so it must
 * never pull in Node.
 */

// ---- session list ---------------------------------------------------------

/** Derived from Claude's last transcript write: ≤30 s active, ≤5 min open. */
export type ActivityState = 'active' | 'open' | 'stale';

/** Whether work web's pool knows of a live PTY for the session. */
export type PtyStatus = 'running' | 'idle';

/** `+N −M` for a session's working tree vs HEAD, across its repos. */
export interface DiffStat {
  added: number;
  deleted: number;
  /** Changed tracked files + untracked files. */
  files: number;
}

/** The tool call a permission prompt is about (from the transcript). */
export interface PermissionRequest {
  /** Tool name as Claude Code calls it (Bash, Edit, WebFetch, mcp__…). */
  tool: string;
  /** What it wants to do: the command, the file, the URL. One line. */
  detail: string;
}

/** POST /api/sessions/:id/answer — answer the permission prompt shown. */
export interface AnswerRequest {
  answer: 'allow' | 'deny';
  /** The request the user was shown; refused if the prompt moved on. */
  request: PermissionRequest;
}

/** Hook-driven agent status as sent to the dashboard (attention inbox). */
export interface SessionAttention extends AttentionLike {
  /** One line: prompt while working, last message when done, the
   *  permission request when blocked. */
  summary?: string;
  updatedAt: string;
  /** A "working" that went quiet for 15 min, shown as idle. */
  stale: boolean;
  /** needs_input on a permission prompt: what it wants to run. */
  request?: PermissionRequest;
}

/** Another live session that changes some of the same files (same repo,
 *  same path): the two will conflict when both merge. */
export interface SessionOverlap {
  sessionId: string;
  target: string;
  branch: string;
  /** How many files both change. */
  count: number;
  /** The first of them (capped), repo alias + root-relative path. */
  files: Array<{ repo: string; path: string }>;
}

/** One row of GET /api/sessions — what every dashboard server (the real
 *  work web and the demo) sends. */
export interface SessionWire {
  id: string;
  target: string;
  branch: string;
  isGroup: boolean;
  paths: string[];
  baseBranch?: string;
  jiraKey?: string;
  createdAt: string;
  lastAccessedAt: string;
  draftCount: number;
  commentCount: number;
  claudeCount: number;
  ptyStatus: PtyStatus;
  lastActivity: number | null;
  activityState: ActivityState;
  pendingForClaudeCount: number;
  attention: SessionAttention | null;
  diffStat: DiffStat | null;
  archivedAt: string | null;
  /** This worktree's dev-server port ($PORT), when it has one. */
  port: number | null;
  /** Other sessions changing the same files; absent when there are none. */
  overlaps?: SessionOverlap[];
}

// ---- ship -----------------------------------------------------------------

export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';

export interface ShipPr {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  /** GitHub mergeStateStatus: CLEAN | DIRTY | BLOCKED | BEHIND | UNSTABLE | HAS_HOOKS | DRAFT | UNKNOWN */
  mergeStateStatus: string;
  checks: ChecksState;
  headSha: string;
  /** When it was merged (ISO), for a MERGED PR. */
  mergedAt?: string;
  /** Checks that failed (name + link), when `checks` is 'fail'. */
  failing?: FailingCheck[];
}

export interface FailingCheck {
  name: string;
  url?: string;
}

export interface RepoShipState {
  /** Repo alias (group sub-repo folder, or the target for a single repo). */
  name: string;
  path: string;
  branch: string;
  /** Local HEAD commit. */
  localSha: string;
  /** Uncommitted (incl. untracked) files — shipping needs a clean tree. */
  dirtyFiles: number;
  /** The branch exists on origin (`origin/<branch>`), whatever the local
   *  tracking config says — `work tree` often leaves it tracking the base. */
  hasUpstream: boolean;
  /** Local tracking is set to `origin/<branch>` (a plain `git push` works). */
  tracksRemote: boolean;
  /** vs `origin/<branch>`; null when the branch isn't on origin. */
  ahead: number | null;
  behind: number | null;
  pr: ShipPr | null;
  /** Nothing left to do here: PR merged with nothing since, or the repo
   *  was never touched. Never blocks the other repos of a group. */
  done: boolean;
  doneReason?: 'merged' | 'untouched';
  /** Why "merge" isn't available right now ([] = go). Empty when done. */
  mergeBlockers: string[];
  /** gh missing / not authenticated / no GitHub remote. */
  ghError?: string;
  /** Commits the remote's default branch doesn't have (null = unknown). */
  commitsVsBase?: number | null;
}

export interface ShipPreflight {
  repos: RepoShipState[];
}

export type ShipAction = 'push' | 'create-pr' | 'merge';
export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** A repo the user chose to merge, with the PR head they were shown. */
export interface MergeSelection {
  name: string;
  headSha: string;
}

export interface ShipResult {
  repo: string;
  ok: boolean;
  message: string;
  url?: string;
  /** For merge: whether this repo's PR was merged by this call. */
  merged?: boolean;
}

/** POST /api/sessions/:id/ship body. */
export type ShipRequest =
  | { action: 'push' | 'create-pr'; draft?: boolean }
  | { action: 'merge'; method?: MergeMethod; repos: MergeSelection[] };

export interface ShipResponse {
  results: ShipResult[];
  archived?: boolean;
  allDone?: boolean;
}

/** POST /api/sessions/:id/revert — undo an uncommitted file, or the lines
 *  of one hunk (new-side range), back to HEAD. */
export interface RevertRequest {
  repo: string;
  path: string;
  lines?: { start: number; end: number };
  /** Leave Claude a note about it (default true). */
  tell?: boolean;
}
export interface RevertResponse {
  ok: true;
  description: string;
}

/** POST /api/presence — one dashboard tab says what it is showing. Sent on
 *  every change and as a heartbeat; `gone` when the tab closes. */
export interface PresenceReport {
  /** Random per tab. */
  clientId: string;
  /** The session the tab shows, or null (Inbox, Sessions table, …). */
  sessionId: string | null;
  visible: boolean;
  focused: boolean;
  /** The tab may show browser notifications (permission granted). */
  canNotify: boolean;
  gone?: boolean;
}

/** SSE `notify` — a session wants the user and nobody is looking at it. */
export interface NotifyEvent {
  sessionId: string;
  kind: 'idle' | 'needs_input';
  title: string;
  body?: string;
}

/** GET /api/sessions/:id/dev — the worktree's port and dev server. */
export interface DevServerState {
  port: number | null;
  /** Something is serving on the port (whoever started it). */
  listening: boolean;
  url: string | null;
  /** The configured dev command for this session, if any. */
  command: string | null;
  repo: string | null;
  /** Started from the dashboard and still alive. */
  running: { pid: number; startedAt: string } | null;
}

/** GET /api/sessions/:id/ci — what GitHub says about the session's PRs. */
export interface SessionCi {
  checkedAt: string;
  repos: Array<{
    name: string;
    pr: ShipPr | null;
    done: boolean;
    /** Unresolved review threads waiting on the author (open PRs). */
    openThreads?: number;
  }>;
}
