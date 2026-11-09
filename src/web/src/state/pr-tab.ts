import type { FailingCheck, OpenReviewThread, PrReply, SessionCi, ThreadCode } from '../../../core/api-types.js';
import { prsBeyondStage, stageOfPr, stagePhrase, stageRepos, type PrStage, type PrStageKind } from '../../../core/pr/pr-stage.js';
import type { ShipPr } from '../../../core/api-types.js';
import { owedToYou } from '../../../core/status/attention.js';
import { stageInputOf } from '../../../core/pr/branch-work.js';
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
  /** Who opened it, when known (the PR watch's look, else the dashboard's list). */
  author: string | null;
  /** The host it's on (absent: GitHub). */
  host?: string;
  /** You did (the watch's viewer for its repo — older: the session's one —, else the list's isMine): its author isn't shown. */
  mine: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  kind: PrStageKind;
  checks: 'pass' | 'fail' | 'pending' | 'none';
  failing: FailingCheck[];
  /** Checks that failed but aren't required: they don't stop the merge (shown quietly, never red). */
  optionalFailing?: FailingCheck[];
  mergedAt?: string;
  /** In a repo the session doesn't have (one of its listed PRs: Claude opened it there). */
  elsewhere?: true;
  /** Only the dashboard's PR list knows it (a second PR from the branch): less is known about it. */
  fromListOnly: boolean;
  /** The branch it's from, when the PR watch said (the session may have worked on several: session-branches.ts). */
  branch?: string;
  /** Its repo has more than one open PR here: the branch tells them apart (shown beside its number). */
  branchShown?: true;
  /** An earlier PR of its repo: the session moved on to a newer one (stageRepos), and this one folds under it. */
  earlier?: true;
}

const LISTED_CHECKS: Record<PrInfo['checksStatus'], PrSection['checks']> = {
  SUCCESS: 'pass',
  FAILURE: 'fail',
  PENDING: 'pending',
  NONE: 'none',
};

/** What the dashboard's list adds to a watched PR: its title, and who opened it (an empty login is unknown). */
function fromList(pr: { author?: string }, l: PrInfo | undefined, viewer: string | undefined) {
  const author = pr.author || l?.author || null;
  const mine = viewer && author ? author.toLowerCase() === viewer.toLowerCase() : (l?.isMine ?? false);
  return { title: l?.title ?? null, author, mine };
}

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

/** Most wanting first: what wants you, then open ones, then merged and closed, then earlier PRs a newer one followed. */
const ORDER = (s: PrSection, wants: number) => (wants > 0 ? 0 : s.state === 'OPEN' ? 1 : s.earlier ? 3 : 2);

export function prSections(ci: SessionCi | null, listed: PrInfo[]): PrSection[] {
  // Per repo, the PR its stage reads (the newest open one across the branches it worked on), then its earlier
  // ones — a PR that merged before the session moved on to a new branch and a new PR.
  const input = stageInputOf(ci);
  const watched: PrSection[] = stageRepos(input).flatMap((r, i) => {
    const repo = input[i];
    const viewer = 'viewer' in repo ? repo.viewer : undefined;
    const section = (pr: ShipPr, branch: string | undefined, earlier: boolean): PrSection => ({
      key: pr.url,
      repo: r.name,
      number: pr.number,
      url: pr.url,
      ...(repo.host ? { host: repo.host } : {}),
      ...fromList(
        pr,
        listed.find((p) => p.url === pr.url),
        viewer ?? ci?.viewer,
      ),
      state: pr.state,
      kind: stageOfPr(pr),
      checks: pr.checks,
      failing: pr.failing ?? [],
      ...(pr.optionalFailing?.length ? { optionalFailing: pr.optionalFailing } : {}),
      ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
      ...('elsewhere' in repo && repo.elsewhere ? { elsewhere: true as const } : {}),
      fromListOnly: false,
      ...(branch ? { branch } : {}),
      ...(earlier ? { earlier: true as const } : {}),
    });
    return r.pr
      ? [
          section(r.pr, r.branch, false),
          ...r.also.map((a) => section(a.pr, a.branch, false)),
          ...r.earlier.map((e) => section(e.pr, e.branch, true)),
        ]
      : [];
  });
  const others: PrSection[] = prsBeyondStage({ prs: watched }, listed).map((p) => ({
    key: p.url,
    repo: p.repoAlias,
    number: p.number,
    url: p.url,
    ...(p.host ? { host: p.host } : {}),
    title: p.title,
    author: p.author || null,
    mine: p.isMine,
    state: 'OPEN',
    kind: kindOfListed(p),
    checks: LISTED_CHECKS[p.checksStatus],
    failing: [],
    fromListOnly: true,
  }));
  // Two open PRs of one repo (from two branches): each says its branch.
  const openIn = (repo: string) => watched.filter((w) => w.repo === repo && w.state === 'OPEN').length;
  const named = watched.map((w) => (w.state === 'OPEN' && w.branch && openIn(w.repo) > 1 ? { ...w, branchShown: true as const } : w));
  return [...named, ...others];
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
 * The header's one line for what waits on you on GitHub: "2 replies to post
 * · 6 open review threads · #1927 checks failing · #212 ready to merge";
 * null when nothing does. The same list as the rail's badge (attention.ts
 * `owedToYou`), with each PR named. It points into the PR tab, where all of
 * it is.
 */
export function prNeedsLine(s: SessionPrFacts): string | null {
  const prs = s.prStage?.prs ?? [];
  const named = (want: (p: PrStage['prs'][number]) => boolean, kind: PrStageKind) => {
    const these = prs.filter(want);
    return these.length ? these.map((p) => `${prName(p, !!s.isGroup)} ${stagePhrase(kind)}`) : [stagePhrase(kind)];
  };
  const parts = owedToYou(s).flatMap((o) => {
    switch (o.kind) {
      case 'turn':
        return []; // a finished turn is the Diff's, not GitHub's
      case 'reply':
        return [`${o.count} ${o.count === 1 ? 'reply' : 'replies'} to post`];
      case 'thread':
        return [`${o.count} open review thread${o.count === 1 ? '' : 's'}`];
      case 'conflict':
        return named((p) => p.kind === 'conflict', 'conflict');
      case 'checks':
        return named((p) => p.kind !== 'conflict' && pressingPr(p), 'checks_failing');
      case 'merge':
        return named((p) => p.kind === 'ready', 'ready');
    }
  });
  return parts.length ? parts.join(' · ') : null;
}

/** A line of the code a review thread is on, as the PR tab draws it. */
export interface ThreadCodeLine {
  kind: 'add' | 'del' | 'ctx';
  /** Its number in the old / new file (none for the side it isn't on). */
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** One of the lines the comment is on. */
  commented: boolean;
}

/**
 * The end of a thread's diff hunk, numbered: the lines the comment is on
 * (the hunk's last `lines`) and a few before them for context — GitHub's
 * hunk ends at the commented line. `skipped`: lines of the hunk not shown
 * above. Pure.
 */
export function threadCodeLines(code: ThreadCode, before = 4): { lines: ThreadCodeLine[]; skipped: number } {
  const [header, ...body] = code.hunk.replace(/\r/g, '').split('\n');
  if (body[body.length - 1] === '') body.pop(); // the hunk ended with a newline: no line after it
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header ?? '');
  let oldNo = m ? Number(m[1]) : 0;
  let newNo = m ? Number(m[2]) : 0;
  const all: ThreadCodeLine[] = [];
  for (const raw of body) {
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    const sign = raw[0];
    const text = raw.slice(1);
    if (sign === '+') all.push({ kind: 'add', oldNo: null, newNo: newNo++, text, commented: false });
    else if (sign === '-') all.push({ kind: 'del', oldNo: oldNo++, newNo: null, text, commented: false });
    else all.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text, commented: false });
  }
  const commented = Math.min(code.lines, all.length);
  for (let i = all.length - commented; i < all.length; i++) all[i].commented = true;
  const from = Math.max(0, all.length - commented - before);
  return { lines: all.slice(from), skipped: from };
}
