import type { FailingCheck, OpenReviewThread, PrReply, SessionCi } from '../../../core/api-types.js';
import { prsBeyondStage, stageOfPr, stagePhrase, type PrStage, type PrStageKind } from '../../../core/pr/pr-stage.js';
import type { PrInfo } from '../api/panes.js';

/**
 * The session's PR tab: every pull request of the session, one section each —
 * a group has one per repo, and one branch can have two (into different
 * bases). The PR watch knows one per repo (`SessionCi`, with checks and
 * review state); the dashboard's PR list adds any other (its title, and a
 * stage read from what the list says). Pure.
 */
export interface PrSection {
  /** Its URL: unique across repos and PRs. */
  key: string;
  repo: string;
  number: number;
  url: string;
  title: string | null;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  kind: PrStageKind;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  failing: FailingCheck[];
  mergedAt?: string;
  /** Only the dashboard's PR list knows it (a second PR from the branch): less is known about it. */
  fromListOnly: boolean;
}

const LISTED_CHECKS: Record<PrInfo['checksStatus'], PrSection['checks']> = {
  SUCCESS: 'pass',
  FAILURE: 'fail',
  PENDING: 'pending',
  NONE: 'none',
};

/** A PR from the dashboard's list, read by the PR watch's own rule (`stageOfPr`): the same PR has the same stage wherever it comes from. */
function kindOfListed(p: PrInfo): PrStageKind {
  return stageOfPr({
    number: p.number,
    url: p.url,
    state: 'OPEN',
    isDraft: p.isDraft,
    mergeStateStatus: p.conflicting ? 'DIRTY' : 'UNKNOWN',
    checks: LISTED_CHECKS[p.checksStatus],
    headSha: '',
    reviewDecision: p.reviewDecision === 'NONE' ? '' : p.reviewDecision,
  });
}

/** Most wanting first: what wants you, then open ones, then merged and closed. */
const ORDER = (s: PrSection, wants: number) => (wants > 0 ? 0 : s.state === 'OPEN' ? 1 : 2);

export function prSections(ci: SessionCi | null, listed: PrInfo[]): PrSection[] {
  const watched: PrSection[] = (ci?.repos ?? []).flatMap((r) =>
    r.pr
      ? [
          {
            key: r.pr.url,
            repo: r.name,
            number: r.pr.number,
            url: r.pr.url,
            title: listed.find((p) => p.url === r.pr!.url)?.title ?? null,
            state: r.pr.state,
            kind: stageOfPr(r.pr),
            checks: r.pr.checks,
            failing: r.pr.failing ?? [],
            ...(r.pr.mergedAt ? { mergedAt: r.pr.mergedAt } : {}),
            fromListOnly: false,
          },
        ]
      : [],
  );
  const others: PrSection[] = prsBeyondStage({ prs: watched }, listed).map((p) => ({
    key: p.url,
    repo: p.repoAlias,
    number: p.number,
    url: p.url,
    title: p.title,
    state: 'OPEN',
    kind: kindOfListed(p),
    checks: LISTED_CHECKS[p.checksStatus],
    failing: [],
    fromListOnly: true,
  }));
  return [...watched, ...others];
}

/** A thread or draft belongs to the section of its PR (number and repo; the number alone when no section has its repo). */
export function belongsTo(section: PrSection, all: PrSection[], t: Pick<OpenReviewThread, 'repo' | 'prNumber'>): boolean {
  if (t.prNumber !== section.number) return false;
  const repoKnown = all.some((s) => s.repo === t.repo);
  return repoKnown ? t.repo === section.repo : true;
}

/** What a section wants from you: its threads with no reply, its drafts to post, failing checks or a conflict. */
export function sectionWants(section: PrSection, waiting: number, drafts: number): number {
  const open = section.state === 'OPEN';
  return waiting + drafts + (open && section.checks === 'fail' ? 1 : 0) + (open && section.kind === 'conflict' ? 1 : 0);
}

/** The sections with their threads and drafts, most wanting first (stable otherwise). */
export function orderedSections(sections: PrSection[], waiting: OpenReviewThread[], replies: PrReply[]) {
  const drafts = replies.filter((r) => r.status === 'draft');
  return sections
    .map((s, i) => {
      const w = waiting.filter((t) => belongsTo(s, sections, t));
      const d = drafts.filter((t) => belongsTo(s, sections, t));
      return {
        section: s,
        waiting: w,
        replies: replies.filter((t) => belongsTo(s, sections, t)),
        wants: sectionWants(s, w.length, d.length),
        i,
      };
    })
    .sort((a, b) => ORDER(a.section, a.wants) - ORDER(b.section, b.wants) || a.i - b.i);
}

/** How a section names its PR: "#212", or "frontend #212" in a group. */
export const prName = (s: Pick<PrSection, 'repo' | 'number'>, isGroup: boolean) => (isGroup ? `${s.repo} #${s.number}` : `#${s.number}`);

/** An open PR that wants you: a conflict, or failing checks — a draft's too (its stage says "draft"). */
const pressingPr = (p: PrStage['prs'][number]) =>
  p.kind === 'conflict' || p.kind === 'checks_failing' || (p.checks === 'fail' && p.kind !== 'merged' && p.kind !== 'closed');

/** What the session's wire says about its PRs, for the tab button and the header (no fetch). */
interface SessionPrFacts {
  prStage?: PrStage | null;
  openReviewThreads?: number;
  replyDrafts?: number;
  isGroup?: boolean;
}

/**
 * The tab's button: "PR · #212 waiting for review" with one PR, "PRs · 2"
 * with several; a badge counting what wants you (open threads, failing
 * checks, conflicts). Null when the session has no PR and nothing about one.
 */
export function prTabButton(s: SessionPrFacts, listed: PrInfo[]): { label: string; meta?: string; badge: number } | null {
  const staged = s.prStage?.prs ?? [];
  const count = staged.length + prsBeyondStage(s.prStage ?? null, listed).length;
  const threads = s.openReviewThreads ?? 0;
  const pressing = staged.filter(pressingPr).length;
  const badge = threads + pressing;
  if (count === 0 && !threads && !s.replyDrafts) return null;
  if (count <= 1) {
    const only = staged[0];
    return { label: 'PR', ...(only ? { meta: `#${only.number} ${stagePhrase(only.kind)}` } : {}), badge };
  }
  return { label: 'PRs', meta: String(count), badge };
}

/**
 * The header's one line for what waits on you on GitHub: "6 open review
 * threads · 2 replies to post · #1927 checks failing"; null when nothing does.
 * It points into the PR tab, where all of it is.
 */
export function prNeedsLine(s: SessionPrFacts): string | null {
  const parts: string[] = [];
  const threads = s.openReviewThreads ?? 0;
  if (threads) parts.push(`${threads} open review thread${threads === 1 ? '' : 's'}`);
  const drafts = s.replyDrafts ?? 0;
  if (drafts) parts.push(`${drafts} ${drafts === 1 ? 'reply' : 'replies'} to post`);
  for (const p of s.prStage?.prs ?? []) {
    if (pressingPr(p)) parts.push(`${prName(p, !!s.isGroup)} ${stagePhrase(p.kind === 'conflict' ? 'conflict' : 'checks_failing')}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
