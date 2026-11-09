import type { WorktreeSession } from '../sessions/session-types.js';
import { howToLift, type LegacyUnsafe } from '../sessions/legacy-unsafe.js';
import { commandsFor, hostName } from '../hosts/commands.js';
import type { SessionCi, ShipPr, ShipPreflight, OpenReviewThread, ThreadCode } from '../api-types.js';
import { DECISION_MARKER } from '../status/attention.js';
import {
  newFeedback,
  openThreadCount,
  reviewMessage,
  type FeedbackItem,
  type ReviewFeedback,
  type SeenStore,
  openThreadsOf,
} from './pr-review.js';
import type { ActivityLog, RunHandle, ScheduleHandle } from '../platform/activity.js';
import { otherPrsOf, workElsewhere } from './branch-work.js';
import { DEFAULT_TRUSTED_BOTS, MAX_THREAD_BODY, subAgentHint } from './pr-review.js';

/** What waking a session's Claude did: started it; it was already running (it has the note);
 *  waking is off; or it couldn't (no PTY host, no worktree). */
export type WakeResult = 'started' | 'running' | 'off' | 'failed';

/**
 * Background PR watch for `work web` (full mode): what GitHub knows about
 * each recent session's PRs, acted on so you don't have to poll it.
 *
 *   - CI state per session, for the session header's CI strip.
 *   - CI newly failing on a PR → tell THAT session's Claude (it has the
 *     context) to fix it, asking you if it needs a decision. Once per PR
 *     head commit, so a push that fails again is reported again.
 *   - New review feedback on an open PR (unresolved threads, reviews,
 *     comments by others — see pr-review.ts) → hand it to that Claude to
 *     address, or to ask you if it needs a decision.
 *   - Every repo done and something merged → archive the session (the
 *     same rule as Ship's merge; a follow-up commit keeps it open).
 *
 * No agent does the watching: this is plain polling of `gh` through the
 * Ship preflight, a few sessions at a time. Both actions are on by
 * default and can be turned off in config (`prWatch`).
 *
 * All I/O is injected, so the policy is testable without git or gh.
 */

export interface PrWatchDeps {
  /** Sessions worth checking (recent, not archived). */
  sessions: () => Array<{ id: string; session: WorktreeSession }>;
  /**
   * The session's repos and their PRs. `resting(host)`: that host refused for its API limit a while ago — don't
   * ask it (the repo reads as no PR; the watch keeps what it knew of it).
   */
  preflight: (session: WorktreeSession, opts?: { resting?: (host: string | undefined) => boolean }) => Promise<ShipPreflight>;
  /** Archive merged work (archiveSession `merged`); resolves to what it kept that was waiting in it ("2 reply drafts"), if anything. */
  archive: (id: string) => Promise<string | void>;
  /** Leave the session's Claude a (published) review note. */
  tell: (id: string, body: string) => Promise<void>;
  broadcast: (event: string, data: unknown) => void;
  options: () => { autoArchive: boolean; fixCi: boolean; fixConflicts?: boolean; reviewComments: boolean; trustedBots?: string[] };
  /** Threads just handed to a session's Claude, for the reply drafts (pr-replies.ts). */
  rememberThreads?: (
    sessionId: string,
    threads: Array<{
      threadId: string;
      repo: string;
      prNumber: number;
      url: string;
      where: string | null;
      reviewer: string;
      excerpt: string;
      body?: string;
      code?: ThreadCode;
    }>,
  ) => void;
  /**
   * Reply rows (handed over or drafted) whose thread this check doesn't list as open: the ones
   * GitHub says are resolved go (pr-replies.ts `retireResolvedReplies`). Returns what went.
   */
  retireReplies?: (sessionId: string, ci: SessionCi) => Promise<string[]>;
  /** How full the session's Claude conversation is (share of its window), for the sub-agent hint. */
  contextShare?: (session: WorktreeSession) => number | null;
  /** What archiving it now would leave unfinished (replies to post, undelivered notes). Merged work
   *  doesn't wait for these — the archive keeps them — so this is only reported. */
  waiting?: (sessionId: string) => string[];
  /** After a note: start the session's Claude if it isn't running, so it works on it now. */
  wake?: (sessionId: string) => Promise<WakeResult>;
  /** Its Claude is in the middle of a turn: not archived until the turn ends. */
  busy?: (sessionId: string) => boolean;
  /** It's a repo's own checkout (`work tree <repo>`, no branch): never archived by the watch —
   *  that's where you go on working after a PR merges, on the next branch. */
  ownCheckout?: (session: WorktreeSession) => boolean;
  /** Look, never act on its own (the dev server, `work web --dev`, next to the real one): checks
   *  keep the PR state current for its dashboard, but tell no Claude, archive nothing, wake nobody.
   *  What you click (Fix CI) still happens. */
  lookOnly?: boolean;
  /** Its agent still runs as started `--unsafe` before the retirement (legacy-unsafe.ts): no review text goes to it.
   *  Which case (legacy-unsafe.ts), so the Activity note can say what lifts it. REMOVE IN THE NEXT RELEASE. */
  runsUnsafe?: (sessionId: string) => LegacyUnsafe | null;
  /** Who you're signed in as on a host (`host`: its id; absent: GitHub): a PR by someone else (you work on it or
   *  review it) is theirs — its review threads are addressed to its author, and its CI isn't yours to fix unasked.
   *  `repoPath`: the repo it's asked for (its origin's server: a GitHub Enterprise login isn't github.com's). */
  viewer?: (host?: string, repoPath?: string) => Promise<string | null>;
  /** The host (`host`: its id; absent: GitHub) refused for its API limit, in its own words (absent: `RATE_LIMITED`).
   *  Wired per host by pr-watch-hosts.ts, as `viewer` and `reviewFeedback` are. */
  rateLimited?: (host: string | undefined, text: string) => boolean;
  /** Review threads/comments on a PR (null when gh can't say). */
  reviewFeedback?: (repoPath: string, prNumber: number) => Promise<ReviewFeedback | null>;
  /** Per session: what was already acted on — CI head commits reported,
   *  review comments handed over (persisted, see pr-watch-store.ts). */
  told: (sessionId: string) => SeenStore;
  /** Its last check of each session, kept across restarts (pr-watch-store.ts): read once at
   *  creation, so the dashboard has the PRs before the first sweep reaches them; written when a
   *  check changes what it knew. */
  saved?: { load(): Array<[string, SessionCi]>; save(sessionId: string, ci: SessionCi): void };
  now?: () => number;
  /** Where its runs and decisions show (the Activity panel). */
  activity?: ActivityLog;
}

export interface PrWatch {
  /** Check every eligible session once. */
  tick(): Promise<void>;
  /** Check one session now (the header asked). */
  /** Re-check one session now. `act: false` only reports (for GETs, which
   *  must not post notes or archive). */
  refresh(id: string, opts?: { act?: boolean }): Promise<SessionCi | null>;
  state(id: string): SessionCi | null;
  /** Ask the session's Claude to fix its failing checks, now. */
  fixNow(id: string): Promise<boolean>;
  /** You replied to (or resolved) a review thread: it no longer waits on you, before the next check reads GitHub again. */
  answered(id: string, threadId: string): void;
  start(intervalMs: number, firstDelayMs?: number): () => void;
}

const CONCURRENCY = 3;
/** gh's words when GitHub's API limit is spent ("API rate limit already exceeded", "secondary rate limit"). */
export const RATE_LIMITED = /rate limit/i;
/** How long the sweeps rest after GitHub said so. */
export const RATE_LIMIT_PAUSE_MS = 10 * 60_000;
/** How long a PR's review threads, read while some were open, are believed: resolving one doesn't move the PR's updatedAt. */
export const THREADS_RECHECK_MS = 10 * 60_000;

/** Where a PR's branch is, for a note about it: the checked-out one needs no word; another branch or repo does. */
export interface PrPlace {
  /** Its own branch, when known. */
  branch?: string;
  /** The branch its repo has checked out now (absent: unknown, or the repo isn't the session's). */
  onBranch?: string;
  /** In a repo the session doesn't have (one of its listed PRs). */
  elsewhere?: boolean;
}

/** " on fix/x (not checked out: …)", " (not one of this session's repos)", or ''. */
export function placeOf(p: PrPlace): string {
  if (p.elsewhere) return ` (not one of this session's repos${p.branch ? `; branch ${p.branch}` : ''})`;
  if (p.onBranch && p.branch && p.branch !== p.onBranch) return ` on ${p.branch} (not checked out: ${p.onBranch} is)`;
  return '';
}

/** What to do about a PR on a branch that isn't checked out, or in a repo the session doesn't have: once per note. */
export function placeLines(items: PrPlace[]): string[] {
  const out: string[] = [];
  if (items.some((p) => !p.elsewhere && p.onBranch && p.branch && p.branch !== p.onBranch))
    out.push(
      "For a PR on a branch that isn't checked out: commit or stash what's in progress, `git switch <its branch>`, do the work and push there, then switch back to the branch you were on and restore what you stashed.",
    );
  if (items.some((p) => p.elsewhere))
    out.push("For a PR in a repo this session doesn't have: work in your checkout of that repo, where you opened it.");
  return out;
}

export function ciFixMessage(
  failing: Array<{ repo: string; number: number; checks: string[]; host?: string } & PrPlace>,
  isGroup: boolean,
  contextShare?: number | null,
): string {
  const lines = failing.map((f) => `- PR #${f.number}${isGroup || f.elsewhere ? ` (${f.repo})` : ''}${placeOf(f)}: ${f.checks.join(', ')}`);
  const hint = subAgentHint(contextShare);
  return [
    'CI is failing:',
    ...lines,
    '',
    `Look at the failures (${[...new Set(failing.map((f) => f.host))]
      .map((h) => `\`${commandsFor(h).checks('<n>')}\`, \`${commandsFor(h).failedLog}\``)
      .join('; ')}), fix them, and push.`,
    'A check that failed for a reason outside the code — a service it calls timed out or answered 5xx, a runner died — needs no change: run it again instead.',
    ...placeLines(failing),
    `If fixing one needs a decision from me — the check is right but the fix changes behaviour, or the check itself looks wrong — don't guess: start your reply with a line \`${DECISION_MARKER} <the question>\`.`,
    ...(hint ? [hint] : []),
  ].join('\n');
}

/**
 * The note for a PR that can't merge into its base any more. Merge, never rebase: the branch is
 * pushed (a rebase needs a force push, which nothing here does), and a merge keeps what reviewers saw.
 * A conflict that takes a choice — both sides changed the same behaviour — is the user's, not a guess.
 */
export function conflictMessage(
  conflicts: Array<{ repo: string; number: number; base: string | null } & PrPlace>,
  isGroup: boolean,
  contextShare?: number | null,
): string {
  const lines = conflicts.map(
    (c) =>
      `- PR #${c.number}${isGroup || c.elsewhere ? ` (${c.repo})` : ''}${placeOf(c)} can't merge into ${c.base ?? 'its base branch'}: ${c.base ? `\`git merge origin/${c.base}\`` : 'merge its base branch from origin'}`,
  );
  const hint = subAgentHint(contextShare);
  return [
    'Merge conflict on a pull request:',
    ...lines,
    '',
    `Bring ${conflicts.length === 1 ? 'the branch' : 'each branch'} up to date: \`git fetch origin\`${isGroup ? ' in that repo' : ''}, then the merge above — a merge, not a rebase, and never a force push (the branch is pushed). Resolve the conflicts keeping what both sides meant, check that it builds and its tests pass, commit the merge and push.`,
    ...placeLines(conflicts),
    `If a conflict needs a decision from me — both sides changed the same behaviour and it isn't clear which should win — don't guess: \`git merge --abort\`, and start your reply with a line \`${DECISION_MARKER} <the question>\`.`,
    ...(hint ? [hint] : []),
  ].join('\n');
}

/**
 * Archive once the session's work is merged: every repo done — or merged
 * with only uncommitted files left, which the archive saves for Restore —
 * and at least one merged PR that is THIS work.
 *
 * "This work": it was merged after the user last entered the session, or
 * its head is exactly the commit the worktree has checked out and the
 * session has been left alone for a day since it was entered. `gh pr view
 * <branch>` also returns a PR merged long ago for a reused branch name; such
 * a PR has another head than the new work, and was merged before it was
 * entered, so it never archives a fresh session. The day's grace is for
 * entering on purpose after the merge — Restore, or `work tree` onto a
 * branch still at the merged tip — which would otherwise be archived again
 * by the next sweep, before any new file was written. (The "merged after
 * you entered" rule alone disarmed a session for good once you re-entered
 * it after the merge, just to look.)
 */
export const REENTERED_GRACE_MS = 24 * 3600_000;

export function shouldAutoArchive(pre: ShipPreflight, session: Pick<WorktreeSession, 'lastAccessedAt'>, now: number): boolean {
  return autoArchiveVerdict(pre, session, now)?.archive === true;
}

/** The checked-out commit is the merged PR's head, or behind it (ship.ts checkedOutMerged). */
function checkedOutMerged(r: ShipPreflight['repos'][number]): boolean {
  return !r.localSha || !r.pr?.headSha || r.localSha === r.pr.headSha || r.behindMergedHead === true;
}

/**
 * A repo the archive may take: done (ship.ts repoDone), or merged at the
 * checked-out commit (or one after it: the PR got commits on GitHub the
 * worktree never pulled) with only uncommitted files left — archiving saves
 * those and Restore puts them back (archive-uncommitted.ts).
 */
function archivable(r: ShipPreflight['repos'][number]): boolean {
  if (r.done) return true;
  return r.pr?.state === 'MERGED' && !r.ahead && checkedOutMerged(r);
}

/** What keeps a merged repo from being archived: work after the merge that only lives in commits. */
function workBeyondMerge(r: ShipPreflight['repos'][number]): string | null {
  const parts: string[] = [];
  if (r.ahead) parts.push(`${r.ahead} unpushed commit${r.ahead === 1 ? '' : 's'}`);
  if (!checkedOutMerged(r)) parts.push('a commit checked out that the PR didn’t merge');
  return parts.length ? `${r.name}: PR merged, but ${parts.join(' and ')}` : null;
}

/**
 * The same rule, with its reason, for the Activity panel: null when no PR
 * of the session is merged (nothing to decide), else whether it archives
 * and, when not, why it keeps the session.
 */
export function autoArchiveVerdict(
  pre: ShipPreflight,
  session: Pick<WorktreeSession, 'lastAccessedAt'>,
  now: number,
): { archive: true } | { archive: false; why: string } | null {
  const merged = pre.repos.filter((r) => r.pr?.state === 'MERGED');
  if (merged.length === 0) return null;
  // A repo GitHub didn't answer for may have an open PR, and one git couldn't read may hold
  // anything: never archive on a guess.
  const unread = pre.repos.filter((r) => (!r.pr && r.ghError) || r.gitError);
  if (unread.length) return { archive: false, why: `couldn't read ${unread.map((r) => r.name).join(', ')}` };
  // Work on another branch the session moved on to (commits not pushed, a PR open) is the session's too:
  // archiving it would hide that work (session-branches.ts).
  const elsewhere = workElsewhere(pre);
  if (elsewhere.length) return { archive: false, why: `work on other branches: ${elsewhere.join('; ')}` };
  // A merged repo isn't done while there is work beyond the merge (repoDone):
  // say which, rather than "not merged" about a merged PR.
  // Every repo that holds it, each with its reason: one merged with work left in it must not hide another not merged at all.
  const open = pre.repos.filter((r) => !archivable(r));
  if (open.length) {
    const beyond = open.map((r) => (r.pr?.state === 'MERGED' ? workBeyondMerge(r) : null));
    const notMerged = open.filter((_, i) => !beyond[i]).map((r) => r.name);
    const why = [...beyond.filter((w): w is string => !!w), ...(notMerged.length ? [`not all merged yet (${notMerged.join(', ')})`] : [])];
    return { archive: false, why: why.join('; ') };
  }
  // Uncommitted files don't hold it: archiving saves them for Restore.
  const entered = Date.parse(session.lastAccessedAt);
  let waiting = false;
  for (const r of merged) {
    const mergedAt = r.pr!.mergedAt ? Date.parse(r.pr!.mergedAt) : NaN;
    if (Number.isFinite(mergedAt) && (!Number.isFinite(entered) || mergedAt > entered)) return { archive: true };
    const sameWork = !!r.pr!.headSha && !!r.localSha && r.pr!.headSha === r.localSha;
    if (sameWork && Number.isFinite(entered)) {
      if (now - entered >= REENTERED_GRACE_MS) return { archive: true };
      waiting = true;
    }
  }
  return waiting
    ? { archive: false, why: 'you opened it after the merge; archiving once it has been left alone for a day' }
    : { archive: false, why: "the merged PR is older work on this branch name, not what's checked out" };
}

/**
 * The check with one review thread taken out, as answered: its repo's open
 * count goes down by one. The watch's thread list is GitHub as of its last
 * check (every 3 minutes), so a reply just posted would otherwise leave the
 * thread "with no reply" — in the session's Needs you line, its review count
 * and the Inbox — until then. The next check reads GitHub again: a reviewer
 * who answers brings the thread back. The same check, unchanged, when the
 * thread isn't in it. Pure.
 */
export function withoutThread(ci: SessionCi, threadId: string): SessionCi {
  if (!ci.repos.some((r) => r.threads?.some((t) => t.threadId === threadId))) return ci;
  return {
    ...ci,
    repos: ci.repos.map((r) => {
      if (!r.threads?.some((t) => t.threadId === threadId)) return r;
      const threads = r.threads.filter((t) => t.threadId !== threadId);
      const { threads: _old, ...rest } = r;
      return {
        ...rest,
        ...(r.openThreads !== undefined ? { openThreads: Math.max(0, r.openThreads - 1) } : {}),
        ...(threads.length ? { threads } : {}),
      };
    }),
  };
}

/**
 * The saved checks worth showing: only of sessions the sweep checks (the rest would never be
 * replaced, and a stage from weeks ago would stay in the Inbox), and made after the session was
 * (one of the same id — target:branch — removed by a build that kept no checks leaves its row).
 */
export function savedChecks(
  rows: Array<[string, SessionCi]>,
  sessions: Array<{ id: string; session: WorktreeSession }>,
): Array<[string, SessionCi]> {
  const created = new Map(sessions.map((s) => [s.id, Date.parse(s.session.createdAt) || 0]));
  return rows.filter(([id, ci]) => created.has(id) && (Date.parse(ci.checkedAt) || 0) >= created.get(id)!);
}

/** How long a session goes on being watched after it was last used. */
export const WATCH_RECENT_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether the PR watch looks at a session: not archived, a folder of it
 * still there, and used in the last 30 days. "Used" is its last `work tree`
 * entry OR its agent's last write (`lastWriteMs`, read only when the entry
 * is older): a session you entered five weeks ago and work in every day
 * through the dashboard dropped out of the watch (reported: its new review
 * threads were never read, so `work pr reply` refused them, and its PR
 * stage, CI notes and auto-archive stopped too).
 */
export function watchable(
  s: WorktreeSession,
  now: number,
  io: { exists: (p: string) => boolean; lastWriteMs: (s: WorktreeSession) => number },
): boolean {
  if (s.archivedAt || !s.paths.some(io.exists)) return false;
  const cutoff = now - WATCH_RECENT_MS;
  return (Date.parse(s.lastAccessedAt) || 0) >= cutoff || io.lastWriteMs(s) >= cutoff;
}

/** A PR of the session with where it is: its repo (its folder when the session has it), its branch, the checked-out one. */
export interface PlacedPr extends PrPlace {
  repo: string;
  host?: string;
  /** The repo's folder; absent for a PR in a repo the session doesn't have. */
  path?: string;
  pr: ShipPr;
}

/** A PR's key among the session's: its repo and its link (one repo may hold yours and someone else's). */
const prKey = (a: { repo: string; url?: string; pr?: { url: string } }): string => `${a.repo} ${a.pr?.url ?? a.url ?? ''}`;

/** Only the place, for a note. */
function placeFields(a: PrPlace): PrPlace {
  return {
    ...(a.branch ? { branch: a.branch } : {}),
    ...(a.onBranch ? { onBranch: a.onBranch } : {}),
    ...(a.elsewhere ? { elsewhere: true } : {}),
  };
}

/**
 * Every PR a preflight found for the session: each repo's checked-out branch's, its other branches' and listed ones
 * (otherPrsOf), and those in repos it doesn't have (`elsewhere`). Pure.
 */
export function prsOfPreflight(pre: ShipPreflight): PlacedPr[] {
  const out: PlacedPr[] = [];
  for (const r of pre.repos) {
    const on = r.branch && r.branch !== 'HEAD' ? r.branch : undefined;
    const base = { repo: r.name, ...(r.host ? { host: r.host } : {}), path: r.path, ...(on ? { onBranch: on } : {}) };
    if (r.pr) out.push({ ...base, pr: r.pr, ...(on ? { branch: on } : {}) });
    for (const o of otherPrsOf(r)) {
      const branch = o.branch || o.pr.headBranch;
      out.push({ ...base, pr: o.pr, ...(branch ? { branch } : {}) });
    }
  }
  for (const e of pre.elsewhere ?? [])
    out.push({ repo: e.repo, ...(e.host ? { host: e.host } : {}), pr: e.pr, ...(e.branch ? { branch: e.branch } : {}), elsewhere: true });
  return out;
}

/** The same from a check (SessionCi): what the CI and conflict notes, and Fix CI, read. Pure. */
export function prsOfCheck(ci: SessionCi): PlacedPr[] {
  const out: PlacedPr[] = [];
  for (const r of ci.repos) {
    const base = { repo: r.name, ...(r.host ? { host: r.host } : {}), ...(r.branch ? { onBranch: r.branch } : {}) };
    if (r.pr) out.push({ ...base, pr: r.pr, ...(r.branch ? { branch: r.branch } : {}) });
    for (const o of r.otherPrs ?? []) {
      const branch = o.branch || o.pr.headBranch;
      out.push({ ...base, pr: o.pr, ...(branch ? { branch } : {}) });
    }
  }
  for (const e of ci.elsewhere ?? [])
    out.push({ repo: e.repo, ...(e.host ? { host: e.host } : {}), pr: e.pr, ...(e.branch ? { branch: e.branch } : {}), elsewhere: true });
  return out;
}

export function createPrWatch(deps: PrWatchDeps): PrWatch {
  const now = deps.now ?? Date.now;
  const states = new Map<string, SessionCi>(deps.saved ? savedChecks(deps.saved.load(), deps.sessions()) : []);
  /** Sessions checked since this watch was made: each one's first check is announced even when it
   *  matches the saved one, so what listens (the stage tracker, the thread counts) sees it as before. */
  const checked = new Set<string>();
  /** The last review feedback per session + repo, the PR's updatedAt it was read at, and when. */
  const feedbackCache = new Map<string, { number: number; updatedAt: string; at: number; fb: ReviewFeedback }>();
  /** A session's check in flight: a refresh joins it instead of starting another. */
  const inflight = new Map<string, Promise<SessionCi | null>>();
  /**
   * Per host (its id; '' for the default, GitHub): asked nothing until then, its API limit spent (see check).
   * Only that host rests: sessions on the others are checked as ever.
   */
  const restingUntil = new Map<string, number>();
  const hostKey = (host: string | undefined) => host ?? '';
  const resting = (host: string | undefined) => (restingUntil.get(hostKey(host)) ?? 0) > now();
  /** Hosts the session's repos were on at its last preflight (else its saved check; empty: never checked). */
  const hostsSeen = new Map<string, Array<string | undefined>>();
  const knownHosts = (id: string) => hostsSeen.get(id) ?? (states.get(id)?.repos ?? []).map((r) => r.host);
  /** Every host the session was last seen on rests: checking it would only ask a host that refused. */
  const allResting = (id: string) => {
    const hosts = knownHosts(id);
    return hosts.length > 0 && hosts.every(resting);
  };
  const restingNames = () =>
    [...restingUntil]
      .filter(([, until]) => until > now())
      .map(([h]) => hostName(h || undefined))
      .join(', ');
  const sessionOf = (id: string) => deps.sessions().find((s) => s.id === id);

  /**
   * A seen-store whose additions wait until `commit()`. Keys for something
   * we tell Claude are only recorded once the note was delivered: marking
   * them first (and swallowing a failed send) lost that feedback for good.
   */
  function staged(id: string) {
    const pending = new Set<string>();
    return {
      has: (k: string) => pending.has(k) || deps.told(id).has(k),
      add: (k: string) => void pending.add(k),
      commit: () => {
        for (const k of pending) deps.told(id).add(k);
        pending.clear();
      },
    };
  }

  /** Send a note; on success record its keys as told. A failure keeps them
   *  un-told, so the next sweep tries again. */
  async function tellThenRecord(id: string, body: string, seen: { commit: () => void }): Promise<boolean> {
    try {
      await deps.tell(id, body);
    } catch {
      return false;
    }
    seen.commit();
    return true;
  }

  /** Its open PRs that can't merge into their base (GitHub's DIRTY, as the PR stage reads it) — on any branch, in any repo. */
  function conflictingOf(ci: SessionCi) {
    return prsOfCheck(ci)
      .filter((a) => a.pr.state === 'OPEN' && a.pr.mergeStateStatus === 'DIRTY')
      .map((a) => ({
        repo: a.repo,
        number: a.pr.number,
        url: a.pr.url,
        headSha: a.pr.headSha,
        base: a.pr.baseBranch ?? null,
        ...placeFields(a),
      }));
  }

  /** Its open PRs whose required checks fail — on any branch, in any repo. */
  function failingOf(ci: SessionCi) {
    return prsOfCheck(ci)
      .filter((a) => a.pr.state === 'OPEN' && a.pr.checks === 'fail')
      .map((a) => ({
        repo: a.repo,
        number: a.pr.number,
        url: a.pr.url,
        headSha: a.pr.headSha,
        checks: (a.pr.failing ?? []).map((f) => f.name),
        ...(a.host ? { host: a.host } : {}),
        ...placeFields(a),
      }));
  }

  /** One check per session at a time: a second asker gets the one running. */
  function check(id: string, session: WorktreeSession, act = true, run?: RunHandle): Promise<SessionCi | null> {
    const running = inflight.get(id);
    if (running) return running;
    const p = checkNow(id, session, act, run).finally(() => inflight.delete(id));
    inflight.set(id, p);
    return p;
  }

  async function checkNow(id: string, session: WorktreeSession, act = true, run?: RunHandle): Promise<SessionCi | null> {
    const name = `${session.target} ${session.branch}`;
    const note = (text: string, level: 'info' | 'action' | 'warn' = 'info') => run?.note(`${name}: ${text}`, { level, sessionId: id });
    let pre: ShipPreflight;
    try {
      pre = await deps.preflight(session, { resting });
      hostsSeen.set(
        id,
        pre.repos.map((r) => r.host),
      );
    } catch (err) {
      note(`couldn't check (${(err as Error).message}); keeping what it knew`, 'warn');
      return states.get(id) ?? null;
    }
    // GitHub refused: every PR reads as "none". Keep what we knew, act on
    // nothing, and let the sweeps rest (each would only spend more).
    const limitedBy = deps.rateLimited ?? ((_host: string | undefined, text: string) => RATE_LIMITED.test(text));
    const limited = pre.repos.find((r) => r.ghError && limitedBy(r.host, r.ghError));
    if (limited) {
      const name = hostName(limited.host);
      const until = now() + RATE_LIMIT_PAUSE_MS;
      restingUntil.set(hostKey(limited.host), until);
      schedule?.pause(until, `${name}'s API limit is spent`);
      note(`${name} says its API limit is spent: keeping what it knew, resting ${RATE_LIMIT_PAUSE_MS / 60_000} min`, 'warn');
      return states.get(id) ?? null;
    }
    // A repo on a host that rests wasn't asked (it reads as no PR): keep what was known of the session, act on nothing.
    const unasked = pre.repos.find((r) => resting(r.host));
    if (unasked) {
      note(`${hostName(unasked.host)}'s API limit is spent: keeping what it knew`);
      return states.get(id) ?? null;
    }
    const opts = deps.options();
    // Someone else's PR (a session working on it or reviewing it): its threads are for its
    // author, and its Claude was told to wait for what you want. Shown, never handed over.
    // Who you are, per repo: on its host and its origin's server (deps.viewer asks each once).
    // Every PR of the session: the checked-out branch's, its other branches' and listed ones, those in other repos.
    const all = prsOfPreflight(pre);
    const viewers = new Map<string, string | null>();
    for (const a of all)
      if (a.pr.author && !viewers.has(a.repo))
        viewers.set(a.repo, await (deps.viewer?.(a.host, a.path) ?? Promise.resolve(null)).catch(() => null));
    const viewer =
      pre.repos
        .filter((r) => !r.host)
        .map((r) => viewers.get(r.name))
        .find((v) => !!v) ??
      [...viewers.values()].find((v) => !!v) ??
      null;
    // Per PR (its link): one repo may hold yours and someone else's.
    const theirs = new Set(
      all
        .filter((a) => {
          const me = viewers.get(a.repo);
          return a.pr.author && me && a.pr.author.toLowerCase() !== me.toLowerCase();
        })
        .map(prKey),
    );
    // Who you are on its host couldn't be told this time (signed out, offline): mine or theirs is unknown, so
    // nothing of it is handed over — its review threads, CI and conflicts wait for a check that can tell. The
    // review read below says who you are too (its own viewer): when it does, that settles it. Never read as
    // yours: someone else's would go to Claude.
    const unsure = new Set(all.filter((a) => deps.viewer && a.pr.author && !viewers.get(a.repo)).map(prKey));
    const unknownOn = (repos: string[]) => [...new Set(repos.map((name) => hostName(all.find((a) => a.repo === name)?.host)))].join(' / ');
    // Review feedback per open PR: counts for the strip, and (when acting)
    // what's new for Claude.
    const feedback: Array<{ repo: string; number: number; items: FeedbackItem[]; host?: string } & PrPlace> = [];
    const feedbackSeen = staged(id);
    const threads = new Map<string, number>();
    const threadList = new Map<string, OpenReviewThread[]>();
    // Review text is other people's writing; an agent still running with permission checks off from before --unsafe
    // was retired would act on it unreviewed. Count threads for the strip, but don't hand them over, and say so in Activity (remove next release).
    const unsafeFromBefore = deps.runsUnsafe?.(id) ?? null;
    const deliverReviews = !unsafeFromBefore;
    if (deps.reviewFeedback && opts.reviewComments) {
      // Every open PR in the session's repos (a PR in another repo has no folder here to read its threads in).
      for (const a of all) {
        const r = a;
        if (r.pr.state !== 'OPEN' || !r.path || theirs.has(prKey(r))) continue;
        // Nothing new can have been said on a PR that hasn't changed since
        // the last read (a comment or review moves its updatedAt). A resolve
        // doesn't move it, though: a read with open threads goes stale after
        // THREADS_RECHECK_MS, or a thread resolved on GitHub stays open here.
        const key = `${id}:${r.repo}:${r.pr.number}`;
        const cached = feedbackCache.get(key);
        const fresh =
          cached &&
          r.pr.updatedAt &&
          cached.number === r.pr.number &&
          cached.updatedAt === r.pr.updatedAt &&
          (openThreadCount(cached.fb) === 0 || now() - cached.at < THREADS_RECHECK_MS);
        const fb = fresh ? cached.fb : await deps.reviewFeedback(r.path, r.pr.number).catch(() => null);
        if (fb && !fresh && r.pr.updatedAt) feedbackCache.set(key, { number: r.pr.number, updatedAt: r.pr.updatedAt, at: now(), fb });
        if (!fb) {
          // gh couldn't say this time: keep this PR's threads from the last check rather than drop to none.
          const was =
            states
              .get(id)
              ?.repos.find((p) => p.name === r.repo)
              ?.threads?.filter((t) => t.prNumber === r.pr.number) ?? [];
          if (was.length) {
            threads.set(r.repo, (threads.get(r.repo) ?? 0) + was.length);
            threadList.set(r.repo, [...(threadList.get(r.repo) ?? []), ...was]);
          }
          // Who you are is unknown too (GitHub's read answers nothing without a viewer): its threads stay held.
          if (act && deliverReviews && unsure.has(prKey(r)))
            note(
              `couldn't read the review threads on #${r.pr.number}, and who you are on ${unknownOn([r.repo])} is unknown: nothing of it is handed to its Claude until it can tell the PR is yours`,
              'warn',
            );
          continue;
        }
        // Who you are wasn't known on its host: the review read's own viewer says it, or it stays held.
        let held = false;
        if (unsure.has(prKey(r)) && r.pr.author) {
          // The read is made on the repo's own server (the host's adapter asks that one), so its viewer is
          // who you are there. GitHub's read answers nothing without one (the `!fb` path above); an empty
          // viewer is another host's way of saying it can't tell.
          const me = fb.viewer.trim();
          if (me) viewers.set(r.repo, me);
          if (me && me.toLowerCase() === r.pr.author.toLowerCase()) unsure.delete(prKey(r));
          else if (me) {
            unsure.delete(prKey(r));
            theirs.add(prKey(r)); // theirs: shown, never handed over (and not counted, as above)
            continue;
          } else held = true;
        }
        threads.set(r.repo, (threads.get(r.repo) ?? 0) + openThreadCount(fb));
        const prNumber = r.pr.number;
        threadList.set(r.repo, [
          ...(threadList.get(r.repo) ?? []),
          ...openThreadsOf(fb, opts.trustedBots ?? DEFAULT_TRUSTED_BOTS).map((t) => ({ ...t, repo: r.repo, prNumber })),
        ]);
        if (act && deliverReviews && held) {
          const open = fb.threads.filter((t) => !t.isResolved).length; // unresolved, whoever spoke last: unknown
          if (open)
            note(
              `${open} open review thread${open === 1 ? '' : 's'} on #${r.pr.number}, but who you are on ${unknownOn([r.repo])} is unknown: not handing ${open === 1 ? 'it' : 'them'} to its Claude until it can tell the PR is yours`,
              'warn',
            );
        } else if (act && unsafeFromBefore) {
          // What it would have been handed, read into a throwaway set: nothing is recorded as told, so it goes
          // over once the agent was restarted.
          const items = newFeedback(fb, `${id}:${r.repo}:${r.pr.number}`, staged(id), {
            trustedBots: opts.trustedBots ?? DEFAULT_TRUSTED_BOTS,
          });
          if (items.length)
            note(
              `${items.length} new review comment${items.length === 1 ? '' : 's'} on #${r.pr.number} held: its agent still runs as started --unsafe, so review text waits until it is restarted — ${howToLift(unsafeFromBefore)}`,
              'warn',
            );
        } else if (act) {
          const items = newFeedback(fb, `${id}:${r.repo}:${r.pr.number}`, feedbackSeen, {
            trustedBots: opts.trustedBots ?? DEFAULT_TRUSTED_BOTS,
          });
          if (items.length)
            feedback.push({
              repo: r.repo,
              number: r.pr.number,
              items,
              ...(r.host ? { host: r.host } : {}),
              ...placeFields(r),
            });
        }
      }
    }
    const ci: SessionCi = {
      checkedAt: new Date(now()).toISOString(),
      ...(viewer ? { viewer } : {}),
      repos: pre.repos.map((r) => ({
        name: r.name,
        ...(r.host ? { host: r.host } : {}),
        ...(viewers.get(r.name) ? { viewer: viewers.get(r.name)! } : {}),
        pr: r.pr,
        ...(r.branch && r.branch !== 'HEAD' ? { branch: r.branch } : {}),
        ...(otherPrsOf(r).length ? { otherPrs: otherPrsOf(r) } : {}),
        done: r.done,
        ...(threads.has(r.name) ? { openThreads: threads.get(r.name)! } : {}),
        ...(threadList.get(r.name)?.length ? { threads: threadList.get(r.name)! } : {}),
      })),
      ...(pre.elsewhere?.length ? { elsewhere: pre.elsewhere } : {}),
    };
    const before = JSON.stringify(states.get(id)?.repos);
    states.set(id, ci);
    const changed = before !== JSON.stringify(ci.repos);
    if (changed) deps.saved?.save(id, ci);
    if (changed || !checked.has(id)) deps.broadcast('ci-changed', { sessionId: id });
    checked.add(id);

    if (!act) return ci;
    // A draft for a thread resolved on GitHub (a bot resolves its own outdated ones) has nothing to
    // answer: it went on saying "1 reply to post", and Post could only refuse.
    const retired = (await deps.retireReplies?.(id, ci).catch(() => [] as string[])) ?? [];
    if (retired.length)
      note(
        `${retired.length} repl${retired.length === 1 ? 'y' : 'ies'} dropped: ${retired.length === 1 ? 'its thread was' : 'their threads were'} resolved on their host`,
        'action',
      );
    if (feedback.length) {
      const n = feedback.reduce((k, f) => k + f.items.length, 0);
      const prs = feedback.map((f) => `#${f.number}`).join(', ');
      const what = `${n} new review comment${n === 1 ? '' : 's'} on ${prs}`;
      const placed = feedback.map((f) => ({ ...f, place: placeOf(f) }));
      const body = reviewMessage(placed, session.isGroup, DECISION_MARKER, deps.contextShare?.(session), placeLines(feedback));
      if (await tellThenRecord(id, body, feedbackSeen)) {
        deps.rememberThreads?.(
          id,
          feedback.flatMap((f) =>
            f.items
              .filter((it) => it.threadId)
              .map((it) => ({
                threadId: it.threadId!,
                repo: f.repo,
                prNumber: f.number,
                url: it.url,
                where: it.where ?? null,
                reviewer: it.author,
                excerpt: it.body.slice(0, 400),
                body: it.body.slice(0, MAX_THREAD_BODY),
                ...(it.code ? { code: it.code } : {}),
              })),
          ),
        );
        note(`handed ${what} to its Claude${await wakeNote(id)}`, 'action');
      } else note(`couldn't hand ${what} to its Claude; trying again next time`, 'warn');
    } else feedbackSeen.commit(); // only history / baselines: nothing to deliver
    if (opts.fixCi) {
      const failing = failingOf(ci).filter((f) => !theirs.has(prKey(f)) && !deps.told(id).has(`${id}:${f.repo}:${f.headSha}`));
      const held = failing.filter((f) => unsure.has(prKey(f)));
      if (held.length)
        note(
          `checks fail on ${held.map((f) => `#${f.number}`).join(', ')}, but who you are on ${unknownOn(held.map((f) => f.repo))} is unknown: not asking its Claude until it can tell the PR is yours`,
          'warn',
        );
      const fresh = failing.filter((f) => !unsure.has(prKey(f)));
      if (fresh.length) {
        const ciSeen = staged(id);
        for (const f of fresh) ciSeen.add(`${id}:${f.repo}:${f.headSha}`);
        const what = fresh.map((f) => `#${f.number} (${f.checks.join(', ') || 'checks'})`).join(', ');
        if (await tellThenRecord(id, ciFixMessage(fresh, session.isGroup, deps.contextShare?.(session)), ciSeen))
          note(`checks fail on ${what}: asked its Claude to fix them${await wakeNote(id)}`, 'action');
        else note(`checks fail on ${what}; couldn't reach its Claude, trying again next time`, 'warn');
      }
    }
    // A conflict: once per PR head (a push that conflicts again — the base moved on — is told again).
    // Someone else's PR is theirs to bring up to date, as its CI is.
    if (opts.fixConflicts !== false) {
      const conflicting = conflictingOf(ci).filter(
        (c) => !theirs.has(prKey(c)) && !deps.told(id).has(`${id}:${c.repo}:conflict:${c.headSha}`),
      );
      const held = conflicting.filter((c) => unsure.has(prKey(c)));
      if (held.length)
        note(
          `merge conflict on ${held.map((c) => `#${c.number}`).join(', ')}, but who you are on ${unknownOn(held.map((c) => c.repo))} is unknown: not asking its Claude until it can tell the PR is yours`,
          'warn',
        );
      const fresh = conflicting.filter((c) => !unsure.has(prKey(c)));
      if (fresh.length) {
        const seen = staged(id);
        for (const c of fresh) seen.add(`${id}:${c.repo}:conflict:${c.headSha}`);
        const what = fresh.map((c) => `#${c.number}${c.base ? ` (into ${c.base})` : ''}`).join(', ');
        if (await tellThenRecord(id, conflictMessage(fresh, session.isGroup, deps.contextShare?.(session)), seen))
          note(`merge conflict on ${what}: asked its Claude to merge the base in and resolve it${await wakeNote(id)}`, 'action');
        else note(`merge conflict on ${what}; couldn't reach its Claude, trying again next time`, 'warn');
      }
    }
    if (opts.autoArchive) {
      const verdict = deps.ownCheckout?.(session) ? null : autoArchiveVerdict(pre, session, now());
      // Merged work decides it: drafts, notes and questions are kept with
      // the archive, not waited for. Only a turn in progress is.
      if (verdict?.archive && deps.busy?.(id)) note('every PR merged; archiving once its Claude finishes this turn');
      else if (verdict?.archive) {
        try {
          const keptWhat = await deps.archive(id);
          const dirty = pre.repos.reduce((n, r) => n + (r.dirtyFiles || 0), 0);
          const kept = keptWhat ? `; ${keptWhat} kept for Restore` : '';
          note(
            dirty
              ? `archived: every PR merged; ${dirty} uncommitted file${dirty === 1 ? '' : 's'} saved, put back on Restore${kept} (the conversation is kept)`
              : `archived: every PR merged${kept || ', nothing uncommitted'} (the conversation is kept)`,
            'action',
          );
        } catch (err) {
          note(`every PR merged, but archiving failed: ${(err as Error).message}`, 'warn');
        }
      } else if (verdict) note(`a PR is merged, but kept: ${verdict.why}`);
    }
    return ci;
  }

  /** Start the Claude that just got a note, if it isn't running; says what happened, for the note. */
  async function wakeNote(id: string): Promise<string> {
    if (!deps.wake) return '';
    const r = await deps.wake(id).catch((): WakeResult => 'failed');
    return r === 'started'
      ? ' (started it: it resumes its conversation and works on it now)'
      : r === 'failed'
        ? " (couldn't start it: it gets the note when it next runs)"
        : '';
  }

  /** The sweep's one-line result, from what it just saw. */
  function sweepSummary(ids: string[]): string {
    let prs = 0;
    let threads = 0;
    let failing = 0;
    for (const id of ids) {
      const ci = states.get(id);
      for (const r of ci?.repos ?? []) threads += r.openThreads ?? 0;
      for (const a of ci ? prsOfCheck(ci) : []) {
        if (a.pr.state !== 'OPEN') continue;
        prs++;
        if (a.pr.checks === 'fail') failing++;
      }
    }
    const parts = [`${ids.length} session${ids.length === 1 ? '' : 's'}`, `${prs} open PR${prs === 1 ? '' : 's'}`];
    if (threads) parts.push(`${threads} unresolved review thread${threads === 1 ? '' : 's'}`);
    if (failing) parts.push(`${failing} failing`);
    return parts.join(' · ');
  }

  let schedule: ScheduleHandle | undefined;

  let running: Promise<void> | null = null;
  const watch: PrWatch = {
    tick() {
      // Only sessions on a host that isn't resting are checked; when that's none of them, the sweep rests.
      const due = deps.sessions().filter((q) => !allResting(q.id));
      if (!running && !due.length && restingNames()) {
        deps.activity?.skip('pr-watch', 'Checking pull requests', `${restingNames()}'s API limit is spent; resting`);
        return Promise.resolve();
      }
      // One sweep at a time: a slow gh must not stack sweeps up.
      running ??= (async () => {
        if (!restingNames()) schedule?.resume();
        const queue = due;
        const ids = queue.map((q) => q.id);
        const run = deps.activity?.start('pr-watch', 'Checking pull requests');
        let done = 0;
        run?.progress(0, ids.length);
        const worker = async () => {
          for (let next = queue.shift(); next; next = queue.shift()) {
            await check(next.id, next.session, !deps.lookOnly, run);
            run?.progress(++done, ids.length);
          }
        };
        try {
          await Promise.all(Array.from({ length: CONCURRENCY }, worker));
          run?.done(sweepSummary(ids));
        } catch (err) {
          run?.fail((err as Error).message);
          throw err;
        }
      })().finally(() => {
        running = null;
      });
      return running;
    },
    async refresh(id, opts) {
      const s = sessionOf(id);
      return s ? check(id, s.session, !deps.lookOnly && (opts?.act ?? true)) : null;
    },
    state: (id) => states.get(id) ?? null,
    answered(id, threadId) {
      const was = states.get(id);
      if (!was) return;
      const ci = withoutThread(was, threadId);
      if (ci === was) return;
      states.set(id, ci);
      deps.saved?.save(id, ci);
      deps.broadcast('ci-changed', { sessionId: id });
    },
    // Your click, not a sweep: a look-only watch does it too (the told-keys are shared, so no one repeats it).
    async fixNow(id) {
      const s = sessionOf(id);
      const ci = s ? await check(id, s.session, false) : null;
      if (!s || !ci) return false;
      const failing = failingOf(ci);
      if (!failing.length) return false;
      const seen = staged(id);
      for (const f of failing) seen.add(`${id}:${f.repo}:${f.headSha}`);
      await deps.tell(id, ciFixMessage(failing, s.session.isGroup, deps.contextShare?.(s.session))); // the route reports a failure
      seen.commit();
      return true;
    },
    start(intervalMs, firstDelayMs = 15_000) {
      schedule = deps.activity?.schedule('pr-watch', 'Pull request check', intervalMs);
      schedule?.next(now() + firstDelayMs);
      const tickAndPlan = () => {
        schedule?.next(now() + intervalMs);
        void watch.tick();
      };
      const first = setTimeout(tickAndPlan, firstDelayMs);
      const every = setInterval(tickAndPlan, intervalMs);
      first.unref?.();
      every.unref?.();
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    },
  };
  return watch;
}
