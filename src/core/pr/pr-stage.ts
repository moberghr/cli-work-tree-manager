/**
 * Where a session's pull request stands, in one word and one line — the
 * session header, the rail's tooltip, the Inbox and `work sessions` say
 * the same. Pure and import-free: the SPA and the demo import it.
 *
 * A PR waiting on others (reviewers, checks) keeps the session out of the
 * Inbox ("In review"); it comes back when the PR wants you again: approved
 * with checks passing (ready to merge), a merge conflict, or failing checks.
 * Review comments come back on their own (`openReviewThreads`).
 */

/** What the stage reads of a PR (ShipPr, the PR watch's last check). */
export interface StagePr {
  number: number;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  mergeStateStatus: string;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  headSha: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED, or '' when the repo requires no review. */
  reviewDecision?: string;
  /** When it merged (ISO), when it did. */
  mergedAt?: string;
}

/** How long another branch's merged PR goes on showing under a session (the PR tab's "earlier"). */
export const EARLIER_SHOWN_MS = 30 * 24 * 3600_000;

export type PrStageKind =
  'draft' | 'in_review' | 'checks_running' | 'checks_failing' | 'changes' | 'conflict' | 'approved' | 'ready' | 'merged' | 'closed';

export interface PrStage {
  kind: PrStageKind;
  /** "PR #212 · approved, ready to merge" */
  text: string;
  /** Each PR with its own stage: a group's are shown (and opened) one by one. Its
   *  checks too (additive): a draft's stage is "draft" whatever its checks say. */
  prs: Array<{ repo: string; number: number; url: string; kind: PrStageKind; checks?: StagePr['checks'] }>;
  /** Changes when the stage or a PR's head does: what "seen" and a snooze compare. */
  key: string;
}

/** The stages that bring a session back to the Inbox (until you've looked). */
export const STAGE_WANTS_YOU: ReadonlySet<PrStageKind> = new Set(['ready', 'conflict', 'checks_failing']);
/** The stages where it waits on others: "In review", out of the Inbox. */
export const STAGE_WAITING: ReadonlySet<PrStageKind> = new Set(['in_review', 'checks_running', 'approved', 'changes']);

const PHRASE: Record<PrStageKind, string> = {
  draft: 'draft',
  in_review: 'waiting for review',
  checks_running: 'checks running',
  checks_failing: 'checks failing',
  changes: 'changes requested',
  conflict: 'merge conflict',
  approved: 'approved',
  ready: 'approved, ready to merge',
  merged: 'merged',
  closed: 'closed',
};

/** One open PR's stage. Most pressing first: a conflict or failing checks outweigh a review. */
export function stageOfPr(pr: StagePr): PrStageKind {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.isDraft) return 'draft';
  if (pr.mergeStateStatus === 'DIRTY') return 'conflict';
  if (pr.checks === 'fail') return 'checks_failing';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changes';
  if (pr.reviewDecision === 'APPROVED') {
    if (pr.checks === 'pending') return 'checks_running';
    // Behind its base or blocked by a rule: approved, not mergeable yet.
    return pr.mergeStateStatus === 'BEHIND' || pr.mergeStateStatus === 'BLOCKED' ? 'approved' : 'ready';
  }
  if (pr.checks === 'pending' && pr.reviewDecision !== 'REVIEW_REQUIRED') return 'checks_running';
  return 'in_review';
}

/** How pressing a stage is, across a group's repos (the session shows its most pressing). */
const RANK: Record<PrStageKind, number> = {
  conflict: 0,
  checks_failing: 1,
  changes: 2,
  draft: 3,
  in_review: 4,
  checks_running: 5,
  approved: 6,
  ready: 7,
  merged: 8,
  closed: 9,
};

/**
 * A session's stage from its repos' PRs: the most pressing open one; `ready`
 * only when every open PR is. Merged when every PR merged; null with no PR.
 */
export function prStageOf(
  repos: ReadonlyArray<{ name: string; pr: StagePr | null; also?: ReadonlyArray<{ pr: StagePr }> }>,
): PrStage | null {
  // A repo's other open PRs (stageRepos' `also`: other branches it worked on) count as its own.
  const withPr = repos.flatMap((r) =>
    r.pr ? [{ name: r.name, pr: r.pr }, ...(r.also ?? []).map((a) => ({ name: r.name, pr: a.pr }))] : [],
  );
  if (!withPr.length) return null;
  const open = withPr.filter((r) => r.pr.state === 'OPEN');
  const shown = open.length ? open : withPr;
  let kind: PrStageKind = 'closed';
  for (const r of shown) {
    const k = stageOfPr(r.pr);
    if (RANK[k] < RANK[kind]) kind = k;
  }
  // `ready` is the least pressing open stage, so the loop above already
  // picked anything less ready that another repo has.
  if (!open.length && withPr.some((r) => r.pr.state === 'MERGED')) kind = 'merged';
  const pr = (r: { name: string; pr: StagePr }) => ({
    repo: r.name,
    number: r.pr.number,
    url: r.pr.url,
    kind: stageOfPr(r.pr),
    checks: r.pr.checks,
  });
  const named = shown.map(pr);
  // Its merged PRs too, after the open ones: a group whose backend merged while
  // its frontend is in review shows both pills, so you know it had (and merged)
  // one. The stage, its text and its key are still the open ones'.
  const prs = [...named, ...withPr.filter((r) => r.pr.state === 'MERGED' && !shown.includes(r)).map(pr)];
  const which = named.length === 1 ? `PR #${named[0].number}` : `PRs ${named.map((p) => `${p.repo} #${p.number}`).join(', ')}`;
  return {
    kind,
    text: kind === 'draft' ? `Draft ${which}` : `${which} · ${PHRASE[kind]}`,
    prs,
    key: `${kind}:${shown.map((r) => `${r.name}@${r.pr.headSha}`).join(',')}`,
  };
}

/**
 * Per repo, the PRs its stage reads, across the branches it worked on (session-branches.ts: Claude may have
 * moved on after a PR merged, to a new branch and a new PR): `pr` the newest open one, else the checked-out
 * branch's own whatever its state — never another branch's merged or closed one (reported: a repo's own checkout on
 * main read "PR #55 · merged", from a branch it was on a month before); `also` every other open one, newest first — a
 * session that opened PRs from two branches of one repo shows both. `earlier`: the merged and closed rest, newest
 * first, those merged over `EARLIER_SHOWN_MS` ago left out — the PR tab folds them under it ("earlier: #3592
 * merged"), and they drop out of the stage's pills. Pure.
 */
export function stageRepos<P extends StagePr>(
  repos: ReadonlyArray<{ name: string; pr: P | null; branch?: string; otherPrs?: ReadonlyArray<{ branch: string; pr: P }> }>,
  now: number = Date.now(),
): Array<{
  name: string;
  pr: P | null;
  branch?: string;
  also: Array<{ branch?: string; pr: P }>;
  earlier: Array<{ branch?: string; pr: P }>;
}> {
  return repos.map((r) => {
    const all: Array<{ branch?: string; pr: P }> = [
      ...(r.pr ? [{ ...(r.branch ? { branch: r.branch } : {}), pr: r.pr }] : []),
      ...(r.otherPrs ?? []).filter((o) => !r.pr || o.pr.url !== r.pr.url),
    ];
    const open = all.filter((x) => x.pr.state === 'OPEN').sort((a, b) => b.pr.number - a.pr.number);
    const chosen = open[0] ?? all.find((x) => x.pr === r.pr) ?? null;
    const recent = (x: { pr: P }) => !x.pr.mergedAt || now - Date.parse(x.pr.mergedAt) < EARLIER_SHOWN_MS;
    return {
      name: r.name,
      pr: chosen?.pr ?? null,
      ...(chosen?.branch ? { branch: chosen.branch } : {}),
      also: open.filter((x) => x !== chosen),
      earlier: all.filter((x) => x !== chosen && x.pr.state !== 'OPEN' && recent(x)).sort((a, b) => b.pr.number - a.pr.number),
    };
  });
}

/** A stage in a word or two, for one PR's pill: "waiting for review", "ready to merge"… */
export const stagePhrase = (kind: PrStageKind): string => (kind === 'ready' ? 'ready to merge' : PHRASE[kind]);

/** How a stage reads at a glance: good (ready), bad (a conflict, failing checks, changes asked), draft, merged, or plain. */
export function stageTone(kind: PrStageKind): 'good' | 'bad' | 'draft' | 'merged' | 'plain' {
  if (kind === 'ready') return 'good';
  if (kind === 'merged') return 'merged';
  if (kind === 'conflict' || kind === 'checks_failing' || kind === 'changes') return 'bad';
  return kind === 'draft' ? 'draft' : 'plain';
}

/** It wants you: a stage that brings it back, not looked at since it got there. */
export function stageWantsYou(stage: (Pick<PrStage, 'kind'> & { seen?: boolean }) | null | undefined): boolean {
  return !!stage && STAGE_WANTS_YOU.has(stage.kind) && !stage.seen;
}

/** A stage as a client sent it back (the snooze and seen routes): its kind and key, or null. */
export function cleanStageRef(raw: unknown): { kind: PrStageKind; key: string } | null {
  const o = raw as { kind?: unknown; key?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.key !== 'string' || !o.key || o.key.length > 2000) return null;
  return typeof o.kind === 'string' && Object.hasOwn(PHRASE, o.kind) ? { kind: o.kind as PrStageKind, key: o.key } : null;
}

/**
 * What a new check says against the stage shown before (its key, '' for
 * none, undefined before the first check): nothing new, a change to show,
 * or one that wants you — to tell you about. The first sight after a start
 * is only shown, never told.
 */
export function stageNews(prevKey: string | undefined, next: PrStage | null): 'none' | 'changed' | 'notify' {
  const key = next?.key ?? '';
  if (key === prevKey) return 'none';
  if (prevKey === undefined || !next) return 'changed';
  return STAGE_WANTS_YOU.has(next.kind) ? 'notify' : 'changed';
}

/** It waits on others: in review. */
export function stageWaiting(stage: Pick<PrStage, 'kind'> | null | undefined): boolean {
  return !!stage && STAGE_WAITING.has(stage.kind);
}

/** Per session, what each new check says against the last one (stageNews), remembering it. */
export function createStageTracker(): (sessionId: string, stage: PrStage | null) => 'none' | 'changed' | 'notify' {
  const shown = new Map<string, string>();
  return (sessionId, stage) => {
    const news = stageNews(shown.get(sessionId), stage);
    shown.set(sessionId, stage?.key ?? '');
    return news;
  };
}

/**
 * The session's open PRs the stage doesn't hold. The PR watch knows one PR
 * per repo (`gh pr view <branch>`), and a branch may have more — one into
 * main and one into dev — which the dashboard's PR list still has: those are
 * shown beside the stage's pills, as plainly open (or draft).
 */
export function prsBeyondStage<T extends { url: string }>(stage: Pick<PrStage, 'prs'> | null | undefined, prs: T[]): T[] {
  if (!stage) return prs;
  const known = new Set(stage.prs.map((p) => p.url));
  return prs.filter((p) => !known.has(p.url));
}
