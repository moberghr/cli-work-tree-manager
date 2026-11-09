import type { CommandRunner } from '../platform/command-runner.js';
import type { PullRequestInfo } from '../pr/pr-types.js';
import type { MergeMethod, PrDiscussionWire, ShipPr } from '../api-types.js';
import type { ReviewFeedback } from '../pr/review-types.js';
import type { PrCommands } from './command-types.js';

/**
 * Where a repo's pull requests live: GitHub today, Azure DevOps next. work
 * talks to one through a `GitHost` (like an agent through an `AgentAdapter`),
 * resolved per repo from its origin (`hostForRepo`, `index.ts`), so a group
 * can mix hosts and nothing outside an adapter knows a host's CLI, URLs or
 * API. Every method takes the `CommandRunner` it runs the host's CLI with
 * (argv only, never a shell: §1.1), so callers and tests pass their own.
 *
 * The shapes it answers in are work's wire types, which keep GitHub's
 * vocabulary (`mergeStateStatus: 'DIRTY'`, `reviewDecision: 'APPROVED'`):
 * another host maps its own words onto them, so nothing past the adapter
 * changes per host.
 */

/** A repo as a host's list sees it: its alias, its folder, its origin. */
export interface HostRepo {
  alias: string;
  path: string;
  origin: string | null;
}

/** A PR looked up by its branch (Ship, the PR watch): one, none, or why the host couldn't say. */
export type PrLookup = { kind: 'pr'; pr: ShipPr } | { kind: 'none' } | { kind: 'error'; error: string };

/** A PR to start a session on (`work tree --pr`, Start from a PR): its branch and who it's from. */
export interface PrForStart {
  number: number;
  title: string;
  url: string;
  branch: string;
  headSha?: string;
  base: string;
  author: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED' | string;
  /** Its branch isn't on origin: who the fork is. */
  fork?: { owner: string };
}

/** A pull request link, read: the repo it's in (`repoId`'s form) and its number. */
export interface PrLink {
  repoId: string;
  number: number;
  /** The link as the host writes it (no tail). */
  url: string;
  /** Short: `repo#12`. */
  label: string;
}

/** A review thread as the host has it right now: who you are, resolved, and whose word is last. */
export interface ThreadNow {
  viewer: string;
  resolved: boolean;
  lastAuthor: string | null;
}

/** A review thread read live, with its pull request: what a reply draft can be made from. */
export interface LiveThread {
  viewer: string;
  resolved: boolean;
  outdated: boolean;
  path: string | null;
  line: number | null;
  originalStartLine: number | null;
  originalLine: number | null;
  first: { author: string; body: string; url: string; diffHunk: string | null } | null;
  last: { author: string; url: string } | null;
  pr: { number: number; url: string; headBranch: string; repoId: string };
}

/** An open PR of a repo, for the review queue (#64): what it is, where its code is, how big. */
export interface OpenPr {
  number: number;
  title: string;
  url: string;
  branch: string;
  headSha: string;
  base: string;
  author: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  /** Logins whose review it asks for by name. */
  requested: string[];
  /** From a fork: its branch isn't on origin (absent: not, or the host didn't say). */
  fork?: true;
  /** When anything on it last changed (a push, a comment, a review); absent: the host's list doesn't say (Azure DevOps). */
  updatedAt?: string;
}

/** A PR's discussion as a host reads it: work's host-neutral shape, without when it was read (the caller's). */
export type PrDiscussion = Omit<PrDiscussionWire, 'at'>;

export type HostResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * How a review submit went. A failure says what went out before it (`posted`: the first N comments, in the order
 * given; `summaryPosted`), and what may have (`inDoubt`: a call that failed without a clear refusal — timed out, a
 * server error, a dropped connection, an answer it couldn't read — which the host may have carried out; `rest`: the
 * steps after it weren't tried): a retry must send none of those again.
 */
export type SubmitReviewResult =
  | { ok: true; url?: string }
  | {
      ok: false;
      error: string;
      posted?: number;
      summaryPosted?: boolean;
      inDoubt?: { comments: number[]; summary: boolean; rest?: boolean };
    };

export interface GitHost {
  /** Stable id, on the wire and in config (`github`, `azure`). */
  readonly id: string;
  /** How the UI and prompts name it ("GitHub"). */
  readonly name: string;
  /** Its CLI, for the Welcome check and the "not installed" messages. */
  readonly cli: {
    cmd: string;
    label: string;
    /** Args that succeed only when it's installed and signed in. */
    checkArgs: string[];
    /** Checked before `checkArgs`, each with Welcome's line when it fails: what the CLI needs beyond itself (az's
     *  azure-devops extension: `az account show` passes without it). */
    requires?: Array<{ args: string[]; failing: string }>;
    /** Welcome's line when it isn't installed. */
    missing: string;
    /** Welcome's line when it runs but fails (signed out). */
    failing: string;
  };

  /** This origin URL is on this host. */
  matches(origin: string): boolean;
  /** The repo's id on the host from its origin (GitHub: `owner/name`, lower case); null when it isn't. */
  repoId(origin: string): string | null;
  /** A pull request link on this host, read; null for anything else. */
  parsePrUrl(text: string): PrLink | null;
  /** The ref a PR's code is at, fetchable from origin without a checkout. */
  prRef(number: number): string;
  /**
   * `prRef` is the PR merged into its target (Azure DevOps' `refs/pull/<n>/merge`), not its head: the head is that
   * commit's second parent. A review is read and commented at the head, never at the merge commit.
   */
  readonly prRefIsMerge?: boolean;

  /** The PRs for the dashboard (yours, and those asking your review) across these repos. */
  list(repos: HostRepo[], run: CommandRunner): Promise<{ prs: PullRequestInfo[]; incomplete: string[] }>;
  /** Who you're signed in as; null when it can't say (asked again next time). */
  viewer(run: CommandRunner, cwd: string): Promise<string | null>;
  /** The PR of a branch in the repo at `cwd`. */
  prForBranch(run: CommandRunner, cwd: string, branch: string): Promise<PrLookup>;
  /**
   * A PR by its number and link — one on a session's PR list (session-prs.ts), on whatever branch, in whatever repo.
   * `cwd`: the repo's folder when the session has it, else a neutral one (a host that needs the repo says so: error).
   */
  prForRef(run: CommandRunner, cwd: string, ref: { number: number; url: string }): Promise<PrLookup>;
  /** A PR by number in a repo (`repoId`), to start a session on it. */
  prByNumber(run: CommandRunner, cwd: string, repoId: string, number: number): Promise<HostResult<{ pr: PrForStart }>>;
  /** Where a PR (by its link) stands: what a "blocked by" waits on. */
  prState(run: CommandRunner, url: string): Promise<HostResult<{ state: 'OPEN' | 'MERGED' | 'CLOSED' }>>;
  /** Open a PR from a pushed branch. */
  createPr(run: CommandRunner, cwd: string, branch: string, opts: { draft: boolean }): Promise<HostResult<{ url?: string }>>;
  /** Merge a PR, only while its head is still the commit the user was shown. */
  mergePr(run: CommandRunner, cwd: string, number: number, method: MergeMethod, headSha: string): Promise<HostResult>;
  /**
   * A MERGED PR from this (gone) branch whose head is exactly `tip` — a squash merge git can't see: its number;
   * null when there's none; undefined when the host couldn't say (branch tidy offers nothing then).
   */
  mergedPr(run: CommandRunner, cwd: string, branch: string, tip: string): Promise<number | null | undefined>;
  /**
   * Every open PR of the repo at `cwd` (the review queue's candidates). `more`: the list stopped at its limit, so a
   * PR missing from it may still be open (the queue then drops no review of that repo).
   */
  openPrs(run: CommandRunner, cwd: string): Promise<HostResult<{ prs: OpenPr[]; more?: boolean }>>;
  /**
   * Submit a review — its line comments, a verdict and a summary — at `commitId`, in one go: only on the user's click.
   */
  submitReview(
    run: CommandRunner,
    cwd: string,
    number: number,
    review: {
      commitId: string;
      event: 'comment' | 'approve' | 'request-changes';
      body: string;
      comments: Array<{ path: string; line: number; body: string }>;
    },
  ): Promise<SubmitReviewResult>;
  /**
   * A PR's existing discussion — its review threads on lines (with side, outdated, resolved and every comment), the
   * submitted reviews and the conversation comments — read only, for the Reviews tab and its AI step (#64). An error
   * says why (in the host's words: `rateLimited` reads them).
   */
  discussion(run: CommandRunner, cwd: string, number: number): Promise<HostResult<{ discussion: PrDiscussion }>>;
  /** A PR's review threads, reviews and comments, and who you are; null when it couldn't say. */
  reviewFeedback(run: CommandRunner, cwd: string, number: number): Promise<ReviewFeedback | null>;

  readonly threads: {
    /** This is one of this host's review-thread ids (checked before an id reaches the CLI or the database). */
    isId(id: string): boolean;
    /**
     * The repo (its `repoId`) a thread id names, when the id carries it (Azure DevOps'): a thread not on one of the
     * session's repos is refused before the host is asked anything. Null: not a valid id. Absent: ids are opaque.
     */
    repoOf?(id: string): string | null;
    now(run: CommandRunner, cwd: string, id: string): Promise<HostResult<{ thread: ThreadNow }>>;
    live(run: CommandRunner, cwd: string, id: string): Promise<HostResult<{ thread: LiveThread }>>;
    /** Resolved on the host; null when it couldn't say (absence never retires a draft). */
    isResolved(run: CommandRunner, cwd: string, id: string): Promise<boolean | null>;
    reply(run: CommandRunner, cwd: string, id: string, body: string): Promise<HostResult<{ url?: string }>>;
    resolve(run: CommandRunner, cwd: string, id: string): Promise<boolean>;
  };

  /** The host refused for its API limit (the watch keeps what it knew and rests). */
  rateLimited(text: string): boolean;
  /** A commit the host made itself (a squash merge), not your work of that day. */
  hostCommit(committerEmail: string): boolean;
  /** The commands a prompt tells an agent to run for a PR (never another host's). */
  commands: PrCommands;
}
