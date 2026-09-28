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

/** Hook-driven agent status as sent to the dashboard (attention inbox). */
export interface SessionAttention extends AttentionLike {
  /** One line: prompt while working, last message when done, the
   *  permission request when blocked. */
  summary?: string;
  updatedAt: string;
  /** A "working" that went quiet for 15 min, shown as idle. */
  stale: boolean;
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
