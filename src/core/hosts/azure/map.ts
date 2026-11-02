import type { ChecksState, FailingCheck, ShipPr } from '../../api-types.js';
import type { PullRequestInfo } from '../../pr/pr-types.js';
import type { ReviewFeedback, ReviewThread } from '../../pr/review-types.js';
import type { OpenPr, PrForStart } from '../types.js';
import { azureThreadId, azureWebUrl, type AzureRepo } from './origin.js';

/**
 * PURE — Azure DevOps' answers (the `az repos` / REST JSON) read into work's
 * wire types, which keep GitHub's vocabulary (#63): every field optional and
 * checked — it is someone else's output.
 *
 *   reviewer votes 10 / 5 → approved; −5 (waiting for author) / −10 (rejected) → changes requested
 *   build policy evaluations → checks passing / failing / running
 *   mergeStatus `conflicts` → conflicting (`DIRTY`); `isDraft` → draft
 *   status active / completed / abandoned → OPEN / MERGED / CLOSED
 *   threads active / pending → open; fixed / closed / wontFix / byDesign → resolved
 */

export interface AzPr {
  pullRequestId?: number;
  title?: string;
  description?: string;
  status?: string;
  isDraft?: boolean;
  mergeStatus?: string;
  sourceRefName?: string;
  targetRefName?: string;
  lastMergeSourceCommit?: { commitId?: string } | null;
  closedDate?: string;
  creationDate?: string;
  createdBy?: { uniqueName?: string; displayName?: string } | null;
  reviewers?: Array<{ uniqueName?: string; displayName?: string; vote?: number; isRequired?: boolean } | null> | null;
  forkSource?: { repository?: { name?: string; project?: { name?: string } } } | null;
}

export interface AzPolicy {
  status?: string;
  configuration?: {
    isBlocking?: boolean;
    isEnabled?: boolean;
    type?: { displayName?: string };
    settings?: { displayName?: string };
  } | null;
}

export interface AzThread {
  id?: number;
  status?: string;
  isDeleted?: boolean;
  threadContext?: { filePath?: string; rightFileStart?: { line?: number }; rightFileEnd?: { line?: number } } | null;
  comments?: Array<{
    id?: number;
    author?: { uniqueName?: string; displayName?: string } | null;
    content?: string;
    publishedDate?: string;
    commentType?: string;
    isDeleted?: boolean;
  } | null> | null;
}

const branch = (ref: string | undefined) => (ref ?? '').replace(/^refs\/heads\//, '');
const lower = (s: string | undefined | null) => (s ?? '').toLowerCase();

export function prState(status: string | undefined): ShipPr['state'] {
  return status === 'completed' ? 'MERGED' : status === 'abandoned' ? 'CLOSED' : 'OPEN';
}

/** The reviewers' votes as GitHub's review decision ('' when nobody is asked). */
export function reviewDecision(pr: AzPr): string {
  const votes = (pr.reviewers ?? []).filter((r) => !!r).map((r) => r!.vote ?? 0);
  if (!votes.length) return '';
  if (votes.some((v) => v < 0)) return 'CHANGES_REQUESTED';
  const required = (pr.reviewers ?? []).filter((r) => r?.isRequired);
  if (required.length ? required.every((r) => (r!.vote ?? 0) > 0) : votes.some((v) => v > 0)) return 'APPROVED';
  return 'REVIEW_REQUIRED';
}

const isBuild = (p: AzPolicy) => /build/i.test(p.configuration?.type?.displayName ?? '');

/** Build policies as checks, and the failing ones by name. */
export function checksOf(policies: AzPolicy[]): { checks: ChecksState; failing: FailingCheck[] } {
  const builds = policies.filter((p) => p.configuration?.isEnabled !== false && isBuild(p) && p.status !== 'notApplicable');
  const failing = builds
    .filter((p) => p.status === 'rejected' || p.status === 'broken')
    .map((p) => ({ name: p.configuration?.settings?.displayName || p.configuration?.type?.displayName || 'build' }));
  if (!builds.length) return { checks: 'none', failing: [] };
  if (failing.length) return { checks: 'fail', failing };
  if (builds.some((p) => p.status === 'queued' || p.status === 'running')) return { checks: 'pending', failing: [] };
  return { checks: 'pass', failing: [] };
}

/** GitHub's mergeStateStatus from what Azure DevOps says: conflicts, draft, a blocking policy not met, or clean. */
export function mergeState(pr: AzPr, policies: AzPolicy[]): string {
  if (pr.mergeStatus === 'conflicts') return 'DIRTY';
  if (pr.isDraft) return 'DRAFT';
  const blocking = policies.filter(
    (p) => p.configuration?.isBlocking && p.configuration?.isEnabled !== false && p.status !== 'notApplicable',
  );
  if (blocking.some((p) => p.status === 'rejected' || p.status === 'broken')) return 'BLOCKED';
  if (blocking.some((p) => p.status !== 'approved')) return 'BLOCKED';
  return 'CLEAN';
}

export const prWebUrl = (repo: Pick<AzureRepo, 'orgUrl' | 'project' | 'repo'>, id: number) => `${azureWebUrl(repo)}/pullrequest/${id}`;

/** A PR (and its policies) as work's ShipPr. */
export function shipPrOf(repo: AzureRepo, pr: AzPr, policies: AzPolicy[]): ShipPr | null {
  const n = pr.pullRequestId;
  const head = pr.lastMergeSourceCommit?.commitId;
  if (typeof n !== 'number' || !head) return null;
  const { checks, failing } = checksOf(policies);
  const state = prState(pr.status);
  return {
    number: n,
    url: prWebUrl(repo, n),
    state,
    isDraft: pr.isDraft === true,
    mergeStateStatus: mergeState(pr, policies),
    checks,
    headSha: head,
    ...(state === 'MERGED' && pr.closedDate ? { mergedAt: pr.closedDate } : {}),
    ...(pr.closedDate || pr.creationDate ? { updatedAt: pr.closedDate ?? pr.creationDate } : {}),
    reviewDecision: reviewDecision(pr),
    ...(pr.createdBy?.uniqueName ? { author: pr.createdBy.uniqueName } : {}),
    ...(pr.targetRefName ? { baseBranch: branch(pr.targetRefName) } : {}),
    ...(failing.length ? { failing } : {}),
  };
}

/** The branch's PR to show: an open one, else the newest. */
export function pickPr(list: AzPr[]): AzPr | null {
  const valid = list.filter((p) => typeof p.pullRequestId === 'number');
  return (
    valid.find((p) => p.status === 'active') ??
    [...valid].sort((a, b) => (b.creationDate ?? '').localeCompare(a.creationDate ?? ''))[0] ??
    null
  );
}

const myVote = (pr: AzPr, me: string) => (pr.reviewers ?? []).find((r) => lower(r?.uniqueName) === lower(me))?.vote;

/** A PR as the dashboard's list row (yours, or asking your review). */
export function prInfoOf(repo: AzureRepo, alias: string, pr: AzPr, me: string): PullRequestInfo | null {
  const n = pr.pullRequestId;
  if (typeof n !== 'number') return null;
  const vote = me ? myVote(pr, me) : undefined;
  const decision = reviewDecision(pr);
  return {
    number: n,
    title: pr.title ?? '',
    branch: branch(pr.sourceRefName),
    url: prWebUrl(repo, n),
    isDraft: pr.isDraft === true,
    checksStatus: 'NONE', // policies are asked per PR by the PR watch, not for the whole list
    reviewDecision: decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED' ? decision : 'NONE',
    myReview: vote === undefined || vote === 0 ? 'NONE' : vote > 0 ? 'APPROVED' : 'CHANGES_REQUESTED',
    isMine: !!me && lower(pr.createdBy?.uniqueName) === lower(me),
    conflicting: pr.mergeStatus === 'conflicts',
    reviewRequested: vote === 0,
    repoAlias: alias,
    ...(me && pr.createdBy?.uniqueName ? { author: pr.createdBy.uniqueName } : {}),
    fork: !!pr.forkSource,
  };
}

export function openPrOf(repo: AzureRepo, pr: AzPr): OpenPr | null {
  const n = pr.pullRequestId;
  const head = pr.lastMergeSourceCommit?.commitId;
  if (typeof n !== 'number' || !head || pr.status !== 'active') return null;
  return {
    number: n,
    title: pr.title ?? '',
    url: prWebUrl(repo, n),
    branch: branch(pr.sourceRefName),
    headSha: head,
    base: branch(pr.targetRefName),
    author: pr.createdBy?.uniqueName ?? '',
    isDraft: pr.isDraft === true,
    // Azure DevOps' PR list says nothing of size: the review queue's size limit can't apply before it's fetched.
    additions: 0,
    deletions: 0,
    requested: (pr.reviewers ?? []).filter((r) => r && (r.vote ?? 0) === 0 && r.uniqueName).map((r) => r!.uniqueName!),
  };
}

export function prForStartOf(repo: AzureRepo, pr: AzPr): PrForStart | null {
  const n = pr.pullRequestId;
  if (typeof n !== 'number') return null;
  return {
    number: n,
    title: pr.title ?? '',
    url: prWebUrl(repo, n),
    branch: branch(pr.sourceRefName),
    ...(pr.lastMergeSourceCommit?.commitId ? { headSha: pr.lastMergeSourceCommit.commitId } : {}),
    base: branch(pr.targetRefName),
    author: pr.createdBy?.uniqueName ?? '',
    state: prState(pr.status),
    ...(pr.forkSource ? { fork: { owner: pr.forkSource.repository?.project?.name ?? 'a fork' } } : {}),
  };
}

export const RESOLVED_THREAD = new Set(['fixed', 'closed', 'wontFix', 'byDesign']);

/** The PR's discussion threads as work's review feedback: people's comments only (Azure's own system notes left out). */
export function feedbackOf(repo: AzureRepo, prNumber: number, threads: AzThread[], viewer: string): ReviewFeedback {
  const out: ReviewThread[] = [];
  for (const t of threads) {
    if (typeof t.id !== 'number' || t.isDeleted) continue;
    const comments = (t.comments ?? []).filter((c) => !!c && !c.isDeleted && c.commentType !== 'system');
    if (!comments.length) continue;
    const url = `${prWebUrl(repo, prNumber)}?discussionId=${t.id}`;
    out.push({
      id: azureThreadId(repo, prNumber, t.id),
      isResolved: RESOLVED_THREAD.has(t.status ?? ''),
      isOutdated: false,
      path: t.threadContext?.filePath ? t.threadContext.filePath.replace(/^\//, '') : null,
      line: t.threadContext?.rightFileEnd?.line ?? t.threadContext?.rightFileStart?.line ?? null,
      code: null,
      comments: comments.map((c) => ({
        id: `${t.id}-${c!.id ?? 0}`,
        author: c!.author?.uniqueName ?? c!.author?.displayName ?? 'unknown',
        // Azure DevOps has no "association": a commenter on a PR is in the organisation (its members are who can).
        association: 'MEMBER',
        body: c!.content ?? '',
        url,
        createdAt: c!.publishedDate ?? '',
      })),
    });
  }
  return { viewer, threads: out, reviews: [], comments: [] };
}
