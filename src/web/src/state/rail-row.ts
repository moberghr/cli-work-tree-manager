import type { SessionSummary } from '../api/client.js';
import type { PrInfo } from '../api/panes.js';
import { relativeTime } from '../utils/time.js';
import { lastActiveAt, owedBadge, waitingOnOthers, type DisplayKind, type OwedBadge } from './session-display.js';
import { prsBeyondStage, stagePhrase, stageTone } from '../../../core/pr/pr-stage.js';
import { snoozeLabel } from '../../../core/rail/snooze.js';

/**
 * What a rail row shows, in the same four places on every row (SessionRail draws them): line 1 the name and a time,
 * line 2 the project and one status, then the PR marks. Pure.
 */

/** The name: your title whole, or its branch with the type prefix (`feat/`, up to the first `/`) apart, drawn muted. */
export function railName(s: Pick<SessionSummary, 'title' | 'titleIsYours' | 'branch' | 'target'>): {
  named: boolean;
  prefix: string;
  rest: string;
} {
  if (s.titleIsYours && s.title) return { named: true, prefix: '', rest: s.title };
  if (!s.branch) return { named: false, prefix: '', rest: s.target };
  const i = s.branch.indexOf('/');
  // Only a real prefix: something before the `/` and a slug after it.
  if (i <= 0 || i === s.branch.length - 1) return { named: false, prefix: '', rest: s.branch };
  return { named: false, prefix: s.branch.slice(0, i + 1), rest: s.branch.slice(i + 1) };
}

/**
 * Line 1's right slot, always a time: how long it has been in its state while its agent asks or works, else when it
 * was last used; `archiving…` / `restoring…` while that happens. In monospace, so times line up row under row. A
 * snoozed row's time is quiet, as its icon is.
 */
export function railTime(s: SessionSummary, kind: DisplayKind, now: number = Date.now()): { text: string; cls: string } {
  if (kind === 'archiving') return { text: 'archiving…', cls: 'wd-rail-slot-archiving' };
  if (kind === 'restoring') return { text: 'restoring…', cls: 'wd-rail-slot-archiving' };
  const since = s.attention?.since ?? s.lastAccessedAt;
  const tone =
    kind === 'needs_input'
      ? 'wd-rail-slot-needs'
      : kind === 'working'
        ? 'wd-rail-slot-working'
        : kind === 'background'
          ? 'wd-rail-slot-background'
          : null;
  if (!tone) return { text: relativeTime(lastActiveAt(s), now), cls: 'wd-mono' };
  return { text: relativeTime(since, now), cls: s.snoozed ? 'wd-mono' : `${tone} wd-mono` };
}

/**
 * Line 2's one status, by preference: snoozed (you asked not to hear of it: what it owes meanwhile is in the hover),
 * else what you owe ("review +2", "merge", "CI"), else in review.
 */
export type RailStatus =
  | { kind: 'owed'; text: string; title: string; owed: OwedBadge }
  | { kind: 'snoozed'; text: string; title: string }
  | { kind: 'review'; text: string; title?: string };

export function railStatus(s: SessionSummary, now = new Date()): RailStatus | null {
  const owed = owedBadge(s);
  if (s.snoozed) {
    return { kind: 'snoozed', text: 'snoozed', title: `Snoozed ${snoozeLabel(s.snoozed, now)}` + (owed ? `\n${owed.title}` : '') };
  }
  if (owed) return { kind: 'owed', text: owed.text, title: owed.title, owed };
  if (waitingOnOthers(s)) return { kind: 'review', text: 'in review', title: s.prStage?.text };
  return null;
}

/** One PR as a dot: its stage's tone (the colour its pill has elsewhere) and `repo #number · stage` for its hover. */
export interface RailPrMark {
  key: string;
  url: string;
  tone: ReturnType<typeof stageTone>;
  label: string;
}

/** How many PR dots a row shows before `+N`. */
export const RAIL_PR_MARKS = 5;

/**
 * A row's PR marks: the PR watch's (each with its stage), then the dashboard's list for the rest (all of them before
 * the watch has looked; after, a second PR from the same branch, which the watch doesn't hold). At most `cap` shown,
 * the rest counted.
 */
export function railPrMarks(
  s: Pick<SessionSummary, 'prStage'>,
  prs: readonly PrInfo[],
  cap = RAIL_PR_MARKS,
): { shown: RailPrMark[]; more: RailPrMark[] } {
  const all: RailPrMark[] = [
    ...(s.prStage?.prs ?? []).map((p) => ({
      key: `${p.repo}#${p.number}`,
      url: p.url,
      tone: stageTone(p.kind),
      label: `${p.repo} #${p.number} · ${stagePhrase(p.kind)}`,
    })),
    ...prsBeyondStage(s.prStage, [...prs]).map((p) => ({
      key: `${p.repoAlias}#${p.number}`,
      url: p.url,
      tone: p.isDraft ? ('draft' as const) : ('plain' as const),
      label: `${p.repoAlias} #${p.number} · ${p.isDraft ? 'draft' : 'open'}`,
    })),
  ];
  return { shown: all.slice(0, cap), more: all.slice(cap) };
}

/** Every PR of a row for its tooltip, since the row shows dots: "PR api #12 · draft", "PRs api #12 · …, web #3 · …". */
export function railPrsText(marks: { shown: RailPrMark[]; more: RailPrMark[] }): string {
  const all = [...marks.shown, ...marks.more];
  if (all.length === 0) return '';
  return `${all.length === 1 ? 'PR' : 'PRs'} ${all.map((m) => m.label).join(', ')}`;
}
