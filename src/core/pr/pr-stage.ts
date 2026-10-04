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
}

export type PrStageKind =
  'draft' | 'in_review' | 'checks_running' | 'checks_failing' | 'changes' | 'conflict' | 'approved' | 'ready' | 'merged' | 'closed';

export interface PrStage {
  kind: PrStageKind;
  /** "PR #212 · approved, ready to merge" */
  text: string;
  /** Each PR with its own stage: a group's are shown (and opened) one by one. */
  prs: Array<{ repo: string; number: number; url: string; kind: PrStageKind }>;
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
export function prStageOf(repos: ReadonlyArray<{ name: string; pr: StagePr | null }>): PrStage | null {
  const withPr = repos.filter((r): r is { name: string; pr: StagePr } => !!r.pr);
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
  const prs = shown.map((r) => ({ repo: r.name, number: r.pr.number, url: r.pr.url, kind: stageOfPr(r.pr) }));
  const which = prs.length === 1 ? `PR #${prs[0].number}` : `PRs ${prs.map((p) => `${p.repo} #${p.number}`).join(', ')}`;
  return {
    kind,
    text: kind === 'draft' ? `Draft ${which}` : `${which} · ${PHRASE[kind]}`,
    prs,
    key: `${kind}:${shown.map((r) => `${r.name}@${r.pr.headSha}`).join(',')}`,
  };
}

/** A stage in a word or two, for one PR's pill: "waiting for review", "ready to merge"… */
export const stagePhrase = (kind: PrStageKind): string => (kind === 'ready' ? 'ready to merge' : PHRASE[kind]);

/** How a stage reads at a glance: good (ready), bad (a conflict, failing checks, changes asked), draft, or plain. */
export function stageTone(kind: PrStageKind): 'good' | 'bad' | 'draft' | 'plain' {
  if (kind === 'ready') return 'good';
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
