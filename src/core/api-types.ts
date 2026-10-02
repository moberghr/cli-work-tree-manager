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

/** An archived session: whether its folder went, and what it was about. */
export interface SessionArchiveInfo {
  worktreeRemoved: boolean;
  keptBecause: string | null;
  promptCount: number;
  /** Its prompts (first and latest), for recall and search. */
  prompts: string[];
  lastSummary: string | null;
  /** What was done and why, written after archiving (null until then). */
  written?: string | null;
  /** Build output cleared from its kept worktree. */
  buildFolders?: { folders: number; bytes: number };
}

/** A session's running Claudes: in your terminal, or run by the app. */
export interface SessionClaudes {
  inTerminal: number;
  inApp: number;
  /** One of them is in the middle of a turn. */
  busy: boolean;
  /** Two or more on one conversation (they would both write to it). */
  duplicate: boolean;
  /** What Claude Code itself says (~/.claude/sessions/<pid>.json): mid-turn, at its prompt, or waiting on you. */
  state?: 'busy' | 'idle' | 'waiting';
  /** When that last changed (ms). */
  stateAt?: number;
  /** While waiting: what for. */
  waitingFor?: string;
}

// ---- merged local branches (Clean up) ---------------------------------------

export interface BranchCandidate {
  /** Repo alias. */
  repo: string;
  repoPath: string;
  branch: string;
  tip: string;
  /** merged: git says so; squash-merged: a merged PR's head is its tip. */
  reason: 'merged' | 'squash-merged';
  prNumber?: number;
  /** An archived session uses it: its Restore needs the branch. */
  archivedSession?: string;
}

/** GET /api/cleanup/branches */
export interface BranchesState {
  scanning: boolean;
  scannedAt: string | null;
  candidates: BranchCandidate[];
}

// ---- build folders (Clean up: space without archiving) ---------------------

export interface BuildFolder {
  path: string;
  bytes: number;
}

export interface BuildFolderCandidate {
  sessionId: string;
  target: string;
  branch: string;
  /** A repo's own checkout (not a worktree `work` made). */
  baseCheckout?: boolean;
  lastActive: string;
  folders: BuildFolder[];
  bytes: number;
}

/** GET /api/cleanup/build-folders */
export interface BuildFoldersState {
  scanning: boolean;
  checked: number;
  total: number;
  scannedAt: string | null;
  candidates: BuildFolderCandidate[];
}

export interface BuildFoldersApplyResult {
  sessionId: string;
  ok: boolean;
  removed: number;
  message: string;
}

// ---- chat (headless Claude, spike) ----------------------------------------

/** stopped: no process (the next message starts one) · exited: it died. */
export type ChatState = 'stopped' | 'starting' | 'working' | 'needs_input' | 'idle' | 'exited';

/** The content block Claude is writing right now (streamed text). */
export interface ChatPartial {
  kind: 'text' | 'thinking';
  text: string;
}

/** A permission prompt waiting for the user. */
export interface ChatPermissionWire {
  id: string;
  toolName: string;
  input: unknown;
  toolUseId: string | null;
  at: number;
}

/** GET /api/sessions/:id/chat, and the first `snapshot` event of its stream. */
export interface ChatSnapshot {
  sessionId: string;
  state: ChatState;
  error: string | null;
  claudeSessionId: string | null;
  /** stream-json lines as Claude wrote them; see core/chat-view.ts. */
  messages: import('./chat-view.js').ChatMessage[];
  partial: ChatPartial | null;
  permissions: ChatPermissionWire[];
  /** The session's Claude runs in the terminal (PTY host) right now. */
  terminalRunning?: boolean;
}

// ---- assistant (Ctrl+K) ---------------------------------------------------

/** POST /api/assistant/context — what the dashboard shows right now, so the
 *  assistant knows what "this" means. */
export interface AssistantView {
  /** The top tab or view: inbox, today, sessions, cleanup, prs, jira, tasks, session. */
  tab: string;
  /** Sub-view (a session's diff / term / comments). */
  sub?: string;
  /** The session on screen, if any. */
  sessionId?: string | null;
  /** Anything else worth saying (e.g. "12 cleanup candidates listed"). */
  note?: string;
}

// ---- cleanup --------------------------------------------------------------

/** What cleanup found: `merged` — safe to delete; `work`/`dirty` — has
 *  something of its own (offered for archiving once a week quiet); `gone` —
 *  folder missing; `keep` — not a candidate. */
export type CleanupVerdict = 'merged' | 'work' | 'dirty' | 'gone' | 'keep';
export type CleanupAction = 'delete' | 'archive' | 'forget';

export interface CleanupRepo {
  name: string;
  path: string;
  exists: boolean;
  /** git could read it. */
  readable: boolean;
  /** Uncommitted + untracked files. */
  dirty: number | null;
  /** Commits not in `base`. */
  ahead: number | null;
  /** 'contained' — nothing of its own; 'squash' — squash-merged; null — has work. */
  merged: 'contained' | 'squash' | null;
  /** The ref compared with (origin/HEAD, origin/main…). */
  base: string | null;
  /** The configured repo itself, not a worktree: never removed. */
  baseCheckout: boolean;
}

export interface CleanupCandidate {
  sessionId: string;
  target: string;
  branch: string;
  isGroup: boolean;
  lastActive: string;
  archivedAt: string | null;
  verdict: CleanupVerdict;
  /** What the view pre-selects; null — shown for information only. */
  suggested: CleanupAction | null;
  reason: string;
  repos: CleanupRepo[];
}

/** GET /api/cleanup — the scan / apply job, polled by the Clean up view. */
export interface CleanupState {
  phase: 'idle' | 'fetching' | 'scanning' | 'applying';
  done: number;
  total: number;
  candidates: CleanupCandidate[];
  results: Array<{ sessionId: string; action: CleanupAction; ok: boolean; message: string }>;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

/** POST /api/cleanup/apply */
export interface CleanupApplyRequest {
  items: Array<{ sessionId: string; action: CleanupAction }>;
}

/** Terminal WebSocket control frame: the session's Claude is running in
 *  a plain terminal (not the PTY host), so nothing was spawned — a second
 *  Claude would share its conversation. Reconnect with `?force=1` to
 *  spawn anyway. */
export interface TerminalElsewhere {
  type: 'elsewhere';
  /** Claude's last transcript write (ms since epoch), or null. */
  lastActivity: number | null;
  state: 'working' | 'needs_input' | 'idle' | null;
  /** A Claude process is known to run on this conversation (Claude's own
   *  process files), not inferred from activity: the tab then offers no way
   *  to start a second one. */
  confirmed?: boolean;
}

/** GET /api/digest — what each session did since a point in time. */
export interface DigestResponse {
  since: string;
  generatedAt: string;
  sessions: DigestSession[];
}

export interface DigestSession {
  sessionId: string;
  target: string;
  branch: string;
  isGroup: boolean;
  /** Where it stands now. */
  state: 'working' | 'needs_input' | 'idle' | null;
  summary?: string;
  /** What you asked it in the window, oldest first (capped). */
  prompts: Array<{ ts: string; text: string }>;
  /** More prompts than listed. */
  morePrompts: number;
  /** Finished turns (checkpoints) in the window, and the names already given to them. */
  turns: number;
  turnLabels: string[];
  /** A transcript was too large to read back to the window's start, so
   *  earlier prompts are missing. */
  partial?: boolean;
  diffStat: DiffStat | null;
  prs: Array<{ repo: string; number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; mergedAt?: string }>;
  archivedAt: string | null;
  /** Newest activity in the window (ISO). */
  lastActivity: string;
  /** How long its Claude worked in the window (work-time.ts; approximate). */
  workedMs?: number;
}

/** A one-click instruction for a session (config `prompts`, or defaults). */
export interface SavedPrompt {
  label: string;
  prompt: string;
  /** Only for these repo aliases / group names; all when absent. */
  repos?: string[];
}

/** GET /api/prompts */
export interface PromptsResponse {
  prompts: SavedPrompt[];
  /** False when these are the built-in defaults (no `prompts` in config). */
  configured: boolean;
}

/** How full the session's Claude conversation is (tokens). */
export interface ContextUsage {
  /** Tokens the conversation holds now (last request's prompt + reply). */
  used: number;
  /** The model's context window. */
  window: number;
  model?: string;
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
  /** Snoozed out of the Inbox right now (snooze.ts): until when, or null for "until it changes". */
  snoozed?: { until: string | null };
  /** Behind its main branch (behind-main.ts, as of the last fetch) — or, when stacked, behind the
   *  session it is stacked on (`stacked`, its local branch): absent when level or unknown. */
  behind?: { base: string; commits: number; conflicts: boolean; stacked?: true };
  /** The live session it is stacked on (stack.ts): made from that session's branch. */
  stackedOn?: { id: string; branch: string; title?: string };
  /** How many live sessions are stacked on this one. */
  stackedChildren?: number;
  /** You have notes on it (session-notes.ts; GET /api/sessions/:id/note). */
  hasNote?: boolean;
  /** What it waits on that isn't done yet (session-blocks.ts): out of the Inbox meanwhile. */
  blockedBy?: BlockerWire[];
  /** It was stacked on a session that merged and is archived: it should move onto main (POST …/retarget). */
  stackParentMerged?: { id: string; branch: string };
  target: string;
  /** The branch it was started on: with target, the session's identity (and its folder's name). */
  branch: string;
  /** Repos whose checkout is on another branch now (Claude switched, or you did); null = detached HEAD. */
  onOtherBranch?: Array<{ repo: string; branch: string | null }>;
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
  /** Claudes running for this session right now (core/live-claudes.ts);
   *  absent when none. */
  claudes?: SessionClaudes;
  /** What its archive kept (archived sessions; session-archive.ts). */
  archive?: SessionArchiveInfo;
  /** Its name: the one you gave it, else its first prompt, else its Jira key. */
  title?: string | null;
  /** The title is one you gave it (not the automatic one). */
  titleIsYours?: boolean;
  /** Other sessions changing the same files; absent when there are none. */
  overlaps?: SessionOverlap[];
  /** Context used by its Claude conversation; null before the first reply. */
  context?: ContextUsage | null;
  /** Unresolved review threads on its open PRs whose last word isn't
   *  yours (the PR watch's count, pr-review.ts); absent when none or not
   *  checked yet. Makes it "Review comments" (session-view.ts). */
  openReviewThreads?: number;
  /** Replies its Claude drafted for you to post on those threads (pr-replies.ts). */
  replyDrafts?: number;
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
  /** When anything on it last changed (a push, a comment, a review): the
   *  PR watch re-reads review threads only when this moved. */
  updatedAt?: string;
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

// ---- the rail's pins and sections (rail-layout.ts) -------------------------------

/** GET /api/rail (and every rail write's answer). */
export type { RailLayout, RailSection, RailPlace, PlacePatch, SectionOp } from './rail-layout.js';

// ---- a session's timeline (timeline.ts) ---------------------------------------------

export type { TimelineEvent, TimelineKind } from './timeline.js';

/** GET /api/sessions/:id/timeline: newest first. */
export interface TimelineWire {
  events: import('./timeline.js').TimelineEvent[];
}

// ---- blocked by (session-blocks.ts) -------------------------------------------------

/** One thing a session waits on. */
export interface BlockerWire {
  key: string;
  kind: 'session' | 'pr';
  label: string;
  sessionId?: string;
  url?: string;
  state?: 'OPEN' | 'MERGED' | 'CLOSED';
}

// ---- your notes on a session (session-notes.ts) ------------------------------------

/** GET / PUT /api/sessions/:id/note */
export interface NoteWire {
  note: { text: string; updatedAt: string } | null;
}

// ---- time per session (work-time.ts) ---------------------------------------------

/** GET /api/sessions/:id/time: how long its Claude worked (approximate: see work-time.ts). */
export interface WorkTimeWire {
  workedMs: number;
  /** Prompts you gave it, in all its transcripts. */
  prompts: number;
  /** The last two weeks, per local day, newest first; days without work left out. */
  byDay: Array<{ day: string; ms: number }>;
  firstAt: string | null;
  lastAt: string | null;
}

// ---- fork (fork.ts) ---------------------------------------------------------------

/** POST /api/sessions/:id/fork: the new session. */
export interface ForkWire {
  sessionId: string;
  paths: string[];
  /** Its Claude was given a summary of the original's conversation. */
  summarized: boolean;
  /** The worktree exists, but its Claude didn't start (the Terminal tab can). */
  startError?: string;
}

// ---- behind main (behind-main.ts) -------------------------------------------------

/** POST /api/sessions/:id/update-from-main: per repo. */
export interface UpdateFromMainWire {
  results: Array<
    | { ok: true; repo: string; how: 'rebase' | 'merge' | 'nothing'; base: string; commits: number }
    | { ok: false; repo: string; reason: string; conflicts?: boolean; base?: string; /** Not for a button: hand it to the session's Claude. */ handOff?: boolean }
  >;
}

// ---- catch me up (catch-up.ts) -------------------------------------------------------

/** GET / POST /api/sessions/:id/catch-up */
export interface CatchUpWire {
  catchUp: { text: string; at: string } | null;
}

// ---- the Jira watch (jira-watch.ts) -----------------------------------------------

/** What the Jira watch did with an issue assigned to you. */
export interface JiraDecision {
  key: string;
  summary: string;
  url: string;
  at: string;
  /** baseline: there when it was turned on · started: worktree + Claude · suggested: not sure, start it yourself · skipped: has a session · failed · dismissed: you said no. */
  action: 'baseline' | 'started' | 'suggested' | 'skipped' | 'failed' | 'dismissed';
  target?: string;
  branch?: string;
  sessionId?: string;
  reason: string;
}

/** GET /api/jira/watch */
export interface JiraWatchState {
  settings: { enabled: boolean; since: string | null };
  /** Newest first; baseline entries left out. */
  decisions: JiraDecision[];
  /** The projects an issue can be started in (for "Start in …"). */
  targets: string[];
  lastRunAt: string | null;
  nextRunAt: string | null;
}

/** What work does in the background (core/activity.ts), for the Activity panel. */
export type ActivityKind = 'pr-watch' | 'pr-list' | 'jira' | 'idle-sleep' | 'cleanup' | 'build-folders' | 'branches' | 'archive' | 'conversations' | 'server' | 'jira-watch' | 'stacks' | 'blocks';

/** One thing a run decided or noticed ("archived …", "kept … because …"). */
export interface ActivityNote {
  at: string;
  text: string;
  /** action: it did something; warn: something stopped it; info: why it didn't. */
  level: 'info' | 'action' | 'warn';
  /** The session it is about (click to open). */
  sessionId?: string;
}

export interface ActivityRun {
  id: number;
  kind: ActivityKind;
  label: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'done' | 'failed' | 'skipped';
  progress: { done: number; total: number } | null;
  /** One line on how it ended (or why it was skipped / failed). */
  summary: string | null;
  notes: ActivityNote[];
  /** The same skip, repeated this many more times (collapsed). */
  repeats?: number;
}

/** A job that runs on its own, and when it runs next. */
export interface ActivitySchedule {
  kind: ActivityKind;
  label: string;
  everyMs: number;
  nextAt: string | null;
  pausedUntil: string | null;
  pausedWhy: string | null;
}

/** GET /api/activity */
export interface ActivityWire {
  running: ActivityRun[];
  /** Finished runs, newest first. */
  recent: ActivityRun[];
  schedules: ActivitySchedule[];
}

/**
 * A review thread handed to a session's Claude, and the reply it drafted
 * for you (pr-replies.ts). GET /api/sessions/:id/replies.
 */
export interface PrReply {
  /** GitHub's thread id (PRRT_…). */
  threadId: string;
  repo: string;
  prNumber: number;
  /** The reviewer comment it answers. */
  url: string;
  where: string | null;
  reviewer: string;
  excerpt: string;
  /** sent: Claude has it; draft: Claude wrote a reply; posted: on GitHub (your click, or `work pr post` on your yes). */
  status: 'sent' | 'draft' | 'posted';
  draft: string | null;
  sentAt: string;
  draftedAt?: string;
  postedAt?: string;
  postedUrl?: string;
  resolved?: boolean;
}

/** GET /api/conversations/search: a session whose kept conversation mentions the query (conversation-store.ts). */
export interface ConversationHit {
  sessionId: string;
  target: string;
  branch: string;
  /** Archived now (Restore brings it back). */
  archived: boolean;
  archivedAt: string | null;
  worktreeRemoved: boolean;
  /** When its conversation was last written (the newest transcript). */
  lastAt: string | null;
  snippets: Array<{ role: 'you' | 'claude' | 'summary'; text: string; at: string | null }>;
}
