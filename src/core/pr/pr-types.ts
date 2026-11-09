/** A pull request as the dashboard lists it, whatever host it's on (core/hosts/). */

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  url: string;
  isDraft: boolean;
  checksStatus: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE';
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE';
  /** Current user's latest review state on this PR. */
  myReview: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'NONE';
  /** Whether the current user is the PR author. */
  isMine: boolean;
  /** It can't merge as it is: a conflict with its base (checks say nothing about that). */
  conflicting: boolean;
  /** Your review was asked for, by name (a team's request isn't known here). */
  reviewRequested: boolean;
  /** Repo alias this PR belongs to (for distinguishing group PRs). */
  repoAlias: string;
  /** Its author's login (absent from a server before this). */
  author?: string;
  /** It comes from a fork: its branch isn't on origin (absent from a server before this). */
  fork?: boolean;
  /** The host it's on (`github`, `azure`; absent from a server before hosts: GitHub). */
  host?: string;
}

/**
 * Map from branch name to array of PRs (one per repo that has a PR for that branch).
 * Single-repo sessions will have at most 1 entry; groups can have multiple.
 */
export type BranchPrMap = Map<string, PullRequestInfo[]>;
