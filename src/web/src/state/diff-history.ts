import type { CheckpointEntry, DiffPoint, SessionBranchSpan, SessionCommit } from '../api/client.js';
import type { DiffLook } from '../../../core/api-types.js';

/**
 * What the Diff tab's "Changes" picker lists, and what a pick means. A
 * session's history is its commits since the branch's base and its turns
 * (checkpoints: the whole working tree at the end of each of Claude's turns),
 * in time order, then what is uncommitted. Any one of them, or any span of
 * them, is a diff between two points (core/diff/diff-points.ts). Pure.
 */
export interface HistoryItem {
  /** Stable across reloads: `c:<sha>`, `t:<checkpoint id>`, `u`. */
  key: string;
  kind: 'commit' | 'turn' | 'uncommitted';
  /** A commit's subject, a turn's name; empty when it has none. */
  title: string;
  /** How it's named short: `604e66a`, `Turn 3`, `Uncommitted`. */
  tag: string;
  /** When: a commit's date, a turn's end. Null for what is uncommitted (now). */
  at: string | null;
  /** The tree just before it, and with it: picking it alone diffs the two. */
  before: DiffPoint;
  after: DiffPoint;
  /** A commit of another branch the session worked on (session-branches.ts): listed under that branch, after
   *  the checked-out branch's history; a span never crosses from one branch to another. */
  branch?: string;
  /** A turn taken on another branch than the turn before it: "fix/a → fix/b". Its diff is mostly the switch
   *  (the files of another branch), not something Claude wrote or reverted. */
  switched?: string;
}

export const UNCOMMITTED_KEY = 'u';

/**
 * Oldest first, what is uncommitted last. Commits are the repo's on screen
 * (`repo`; a commit belongs to one repo), turns cover every repo. A commit
 * and a turn at the same moment: the commit first, since the turn's
 * snapshot was taken after it.
 */
export function historyItems(
  entries: CheckpointEntry[],
  commits: SessionCommit[],
  repo: string | null,
  turnBranch?: TurnBranch,
): HistoryItem[] {
  // A turn taken on another branch is listed under that branch (branchGroups), not in this one's timeline.
  const turns = turnItems(entries, turnBranch).filter((t) => !t.branch);
  const own: HistoryItem[] = commits
    // Another branch's commits are listed under it (branchGroups), not in this branch's timeline.
    .filter((c) => !c.branch && (repo === null || c.repo === repo))
    .map((c) => ({
      key: `c:${c.sha}`,
      kind: 'commit',
      title: c.subject,
      tag: c.sha.slice(0, 7),
      at: c.at,
      before: { kind: 'parent', repo: c.repo, sha: c.sha },
      after: { kind: 'commit', repo: c.repo, sha: c.sha },
    }));
  const time = (i: HistoryItem) => Date.parse(i.at ?? '') || 0;
  const timeline = [...own, ...turns].sort((a, b) => time(a) - time(b) || (a.kind === 'commit' ? -1 : 1) - (b.kind === 'commit' ? -1 : 1));
  return [
    ...timeline,
    {
      key: UNCOMMITTED_KEY,
      kind: 'uncommitted',
      title: '',
      tag: 'Uncommitted',
      at: null,
      before: { kind: 'head' },
      after: { kind: 'working' },
    },
  ];
}

/**
 * Which other branch a turn was taken on, for the repo on screen: its name when that isn't the branch checked out
 * now, else null (this branch's, or not recorded). The Diff tab's own rule (DiffView), passed to every list built
 * from the turns so a pick means the same in each.
 */
export type TurnBranch = (turn: CheckpointEntry) => string | null;

/**
 * The branch a turn recorded for a repo (by its folder's name: turns record each repo by its root), or null when
 * it recorded none. Pure.
 */
export function branchAt(branches: CheckpointEntry['branches'], repo: string): string | null {
  if (!branches) return null;
  if (repo in branches) return branches[repo] ?? null;
  const key = Object.keys(branches).find((root) => (root.split(/[\\/]/).filter(Boolean).pop() ?? root) === repo);
  return key ? (branches[key] ?? null) : null;
}

/** The rule for the repo on screen: a turn on a branch other than `current` belongs to that branch. */
export function turnBranchFor(repo: string, current: string | null): TurnBranch {
  return (e) => {
    const b = branchAt(e.branches, repo);
    return b && b !== current ? b : null;
  };
}

/**
 * Every turn, oldest first, named by its checkpoint id (they count up from Initial's 0), so its number never
 * shifts. One whose predecessor is gone (the oldest turns are dropped past MAX_CHECKPOINTS) isn't listed: diffed
 * from Initial it would show every dropped turn as its own. It stays inside spans and the branch's scope. A turn
 * on another branch (`turnBranch`) carries it.
 */
function turnItems(entries: CheckpointEntry[], turnBranch?: TurnBranch): HistoryItem[] {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  return sorted.flatMap((e, i): HistoryItem[] => {
    if (i === 0 || sorted[i - 1].id !== e.id - 1) return [];
    const switched = branchSwitch(sorted[i - 1], e);
    const branch = turnBranch?.(e) ?? null;
    return [
      {
        key: `t:${e.id}`,
        kind: 'turn',
        title: e.label && e.label.trim() && e.label !== 'Initial' ? e.label.trim() : '',
        tag: `Turn ${e.id}`,
        at: e.ts,
        before: { kind: 'checkpoint', id: sorted[i - 1].id },
        after: { kind: 'checkpoint', id: e.id },
        ...(switched ? { switched } : {}),
        ...(branch ? { branch } : {}),
      },
    ];
  });
}

/**
 * The branch switch a turn crossed: the first repo whose checked-out branch differs from the turn before's,
 * as "fix/a → fix/b" (a detached HEAD reads "detached"); null when none did, or either turn didn't record its
 * branches (from before). Pure.
 */
export function branchSwitch(prev: Pick<CheckpointEntry, 'branches'>, next: Pick<CheckpointEntry, 'branches'>): string | null {
  if (!prev.branches || !next.branches) return null;
  for (const [repo, b] of Object.entries(next.branches)) {
    if (!(repo in prev.branches)) continue;
    const a = prev.branches[repo];
    if (a !== b) return `${a ?? 'detached'} → ${b ?? 'detached'}`;
  }
  return null;
}

/** The commits and turns of one of the session's other branches. */
export interface BranchGroup {
  branch: string;
  /** Newest first, as the picker shows them. */
  items: HistoryItem[];
}

/**
 * The other branches the session worked on, with their commits (`repo`: the repo on screen, null for every
 * repo's) and the turns taken on them (`turnBranch`), the branch with the newest first. Pure.
 */
export function branchGroups(
  commits: SessionCommit[],
  repo: string | null,
  entries: CheckpointEntry[] = [],
  turnBranch?: TurnBranch,
): BranchGroup[] {
  const byBranch = new Map<string, HistoryItem[]>();
  for (const t of turnItems(entries, turnBranch)) {
    if (!t.branch) continue;
    byBranch.set(t.branch, [...(byBranch.get(t.branch) ?? []), t]);
  }
  for (const c of commits) {
    if (!c.branch || (repo !== null && c.repo !== repo)) continue;
    const list = byBranch.get(c.branch) ?? [];
    list.push({
      key: `c:${c.sha}`,
      kind: 'commit',
      title: c.subject,
      tag: c.sha.slice(0, 7),
      at: c.at,
      before: { kind: 'parent', repo: c.repo, sha: c.sha },
      after: { kind: 'commit', repo: c.repo, sha: c.sha },
      branch: c.branch,
    });
    byBranch.set(c.branch, list);
  }
  const time = (i: HistoryItem) => Date.parse(i.at ?? '') || 0;
  return [...byBranch]
    .map(([branch, items]) => ({ branch, items: items.sort((a, b) => time(b) - time(a)) }))
    .sort((a, b) => time(b.items[0]) - time(a.items[0]));
}

/**
 * The checked-out branch's history (historyItems), then every other branch's commits (branchGroups; oldest
 * first within each, as the rest of the list): one list a pick's keys are found in.
 */
export function allHistoryItems(
  entries: CheckpointEntry[],
  commits: SessionCommit[],
  repo: string | null,
  turnBranch?: TurnBranch,
): HistoryItem[] {
  return [
    ...historyItems(entries, commits, repo, turnBranch),
    ...branchGroups(commits, repo, entries, turnBranch).flatMap((g) => [...g.items].reverse()),
  ];
}

/**
 * Everything on another branch the session worked on, named by it. With its span (the server's: the last base
 * it took in, to its tip) it is that whole diff — merged or not, its base's own changes never in it; without one,
 * its commits as one span. Null when nothing of it is listed.
 */
export function branchSelection(items: HistoryItem[], branch: string, spans: SessionBranchSpan[] = []): DiffSelection | null {
  const commits = items.filter((x) => x.branch === branch && x.kind === 'commit');
  const mine = commits.length ? commits : items.filter((x) => x.branch === branch);
  if (!mine.length) return null;
  const first = mine[0];
  const last = mine[mine.length - 1];
  const repo = first.after.kind === 'commit' ? first.after.repo : null;
  const span = spans.find((s) => s.branch === branch && s.repo === repo && last.after.kind === 'commit' && last.after.sha === s.tip);
  return {
    kind: 'range',
    fromKey: first.key,
    toKey: last.key,
    ...(span ? { from: { kind: 'commit' as const, repo: span.repo, sha: span.base } } : {}),
    label: branch,
  };
}

/** The other branch a selection is of (both its ends on it), or null: the checked-out branch's history, a scope. Pure. */
export function shownBranchOf(items: HistoryItem[], sel: DiffSelection): string | null {
  if (sel.kind !== 'range') return null;
  const to = items.find((x) => x.key === sel.toKey);
  const from = items.find((x) => x.key === sel.fromKey);
  return to?.branch && to.branch === from?.branch ? to.branch : null;
}

/**
 * What the Diff tab shows: a scope (what is uncommitted, or everything since
 * the branch's base — the two tabs), or a span of the list, by key. `from`
 * overrides where the span starts ("since you looked" starts at the
 * checkpoint you saw, not at the item after it); `label` names it.
 */
export type DiffSelection =
  { kind: 'scope'; base: 'uncommitted' | 'branch' } | { kind: 'range'; fromKey: string; toKey: string; from?: DiffPoint; label?: string };

export const UNCOMMITTED: DiffSelection = { kind: 'scope', base: 'uncommitted' };
export const SINCE_BRANCH: DiffSelection = { kind: 'scope', base: 'branch' };

function span(items: HistoryItem[], sel: DiffSelection): [number, number] | null {
  if (sel.kind !== 'range') return null;
  const i = items.findIndex((x) => x.key === sel.fromKey);
  const j = items.findIndex((x) => x.key === sel.toKey);
  if (i < 0 || j < 0) return null;
  // A span is within one branch's history: from another branch's commit into this one's means nothing.
  if (items[i].branch !== items[j].branch) return null;
  return [Math.min(i, j), Math.max(i, j)];
}

/** The two points a span diffs between; null for a scope, or a span whose items are gone (a rewritten commit). */
export function selectionRange(items: HistoryItem[], sel: DiffSelection): { from: DiffPoint; to: DiffPoint } | null {
  const s = span(items, sel);
  if (!s || sel.kind !== 'range') return null;
  return { from: sel.from ?? items[s[0]].before, to: items[s[1]].after };
}

/** Whether a row is part of what's shown: the picker marks them. */
export function inSelection(items: HistoryItem[], sel: DiffSelection, key: string): boolean {
  // "Everything on the branch" is the checked-out branch's: another branch's commits aren't in it.
  if (sel.kind === 'scope') return (sel.base === 'branch' && !items.find((x) => x.key === key)?.branch) || key === UNCOMMITTED_KEY;
  const s = span(items, sel);
  const at = items.findIndex((x) => x.key === key);
  return !!s && at >= s[0] && at <= s[1];
}

/**
 * One row picked (a click), or a span from `anchor` to it (Shift+click).
 * What is uncommitted alone is the Uncommitted scope: the same diff, and the
 * one Revert works in.
 */
export function pick(key: string, anchor?: string | null): DiffSelection {
  if (anchor && anchor !== key) return { kind: 'range', fromKey: anchor, toKey: key };
  return key === UNCOMMITTED_KEY ? UNCOMMITTED : { kind: 'range', fromKey: key, toKey: key };
}

/** "Last turn": the newest turn alone; null before the first. */
export function lastTurn(items: HistoryItem[]): DiffSelection | null {
  const t = [...items].reverse().find((x) => x.kind === 'turn');
  return t ? { kind: 'range', fromKey: t.key, toKey: t.key, label: 'Last turn' } : null;
}

/**
 * "Since you looked": from the turn you last saw to the working tree —
 * every turn and commit after it marked. Null when nothing came after it.
 */
export function sinceLooked(
  items: HistoryItem[],
  entries: CheckpointEntry[],
  seenId: number | null | undefined,
  /** The marked turn's own time: a re-baselined scope reuses its number for another turn, which isn't what you saw. */
  seenTs?: string,
): DiffSelection | null {
  if (seenId === null || seenId === undefined) return null;
  const seen = entries.find((e) => e.id === seenId);
  if (!seen || (seenTs && seen.ts !== seenTs) || !entries.some((e) => e.id > seenId)) return null;
  return fromTurn(items, seen, 'Since you looked');
}

/** From a turn to the working tree, every turn and commit after it marked. */
function fromTurn(items: HistoryItem[], turn: CheckpointEntry, label: string): DiffSelection {
  const at = Date.parse(turn.ts);
  const first = items.find(
    (x) =>
      x.kind !== 'uncommitted' && !x.branch && (x.after.kind === 'checkpoint' ? x.after.id > turn.id : (Date.parse(x.at ?? '') || 0) > at),
  );
  return {
    kind: 'range',
    fromKey: first?.key ?? UNCOMMITTED_KEY,
    toKey: UNCOMMITTED_KEY,
    from: { kind: 'checkpoint', id: turn.id },
    label,
  };
}

/**
 * The update chip's "Only new": what changed since the diff on screen was read — from the newest turn taken
 * before its request started (that diff has it) to the working tree. Turn granularity: changes on screen that
 * no turn captured yet (read mid-turn) come round again. Null with no turn before it, or when it isn't known
 * when the diff on screen was read. Pure.
 */
export function onlyNew(items: HistoryItem[], entries: CheckpointEntry[], readAtMs: number | undefined): DiffSelection | null {
  if (readAtMs === undefined) return null;
  let turn: CheckpointEntry | undefined;
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t <= readAtMs && (!turn || e.id > turn.id)) turn = e;
  }
  return turn ? fromTurn(items, turn, 'Only new') : null;
}

/** When a look was, the way people say it: "Today 14:05", "Yesterday 17:40", "Mon 6 Oct 09:12" (local time). Pure. */
export function lookWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** One of your looks, for the picker: what it showed (a selection), when, and which turns. */
export interface LookEntry {
  key: string;
  selection: Extract<DiffSelection, { kind: 'range' }>;
  when: string;
  turns: string;
}

/**
 * Your looks (diff-looks.ts), newest first, each as the span it showed then: from
 * the turn you had looked at to the turn you looked as far as — the same diff
 * "Since you looked" showed, ending at that turn. One whose turns are gone (the
 * oldest dropped past MAX_CHECKPOINTS) is left out. Pure.
 */
export function yourLooks(items: HistoryItem[], entries: CheckpointEntry[], looks: DiffLook[] | undefined, now = new Date()): LookEntry[] {
  const tsOf = new Map(entries.map((e) => [e.id, e.ts]));
  // Still the turns you saw: there, and (when the look says) the same turns, not a number reused after a re-baseline.
  const same = (id: number, ts?: string) => tsOf.has(id) && (!ts || tsOf.get(id) === ts);
  const out: LookEntry[] = [];
  for (const look of [...(looks ?? [])].reverse()) {
    if (!same(look.from, look.fromTs) || !same(look.to, look.toTs)) continue;
    const fromAt = Date.parse(entries.find((e) => e.id === look.from)!.ts);
    const toKey = `t:${look.to}`;
    const toIdx = items.findIndex((x) => x.key === toKey);
    if (toIdx < 0) continue;
    // The first thing after the turn you had seen, up to the one you looked as far as (commits between included).
    const first = items
      .slice(0, toIdx + 1)
      .find((x) => !x.branch && (x.after.kind === 'checkpoint' ? x.after.id > look.from : (Date.parse(x.at ?? '') || 0) > fromAt));
    if (!first) continue;
    const when = lookWhen(look.startedAt, now);
    const n = look.to - look.from;
    out.push({
      key: `${look.from}-${look.to}-${look.startedAt}`,
      selection: { kind: 'range', fromKey: first.key, toKey, from: { kind: 'checkpoint', id: look.from }, label: `Your look · ${when}` },
      when,
      turns: n === 1 ? `Turn ${look.to}` : `Turns ${look.from + 1}–${look.to}`,
    });
  }
  return out;
}

/**
 * A selection's name while it still says what it shows: "Last turn" only
 * while no newer turn came (the diff stays on the turn picked — nothing is
 * swapped under a reader — and is then called by its own name).
 */
export function liveLabel(items: HistoryItem[], sel: DiffSelection): string | undefined {
  if (sel.kind !== 'range' || !sel.label) return undefined;
  if (sel.label === 'Last turn') {
    const newest = [...items].reverse().find((x) => x.kind === 'turn');
    if (newest?.key !== sel.toKey) return undefined;
  }
  return sel.label;
}

/** How the picker's button names what's shown. */
export function selectionLabel(items: HistoryItem[], sel: DiffSelection): string {
  // A scope is named by its tab; the picker then says it shows all of it.
  if (sel.kind === 'scope') return 'all';
  const label = liveLabel(items, sel);
  if (label) return label;
  const s = span(items, sel);
  if (!s) return 'Uncommitted';
  const [a, b] = [items[s[0]], items[s[1]]];
  if (a === b) return a.title ? `${a.tag} · ${a.title}` : a.tag;
  return `${a.tag} → ${b.tag}`;
}

/** Same selection, as far as what it shows goes (a stable key for reloads). */
export function selectionKey(sel: DiffSelection): string {
  return sel.kind === 'scope' ? sel.base : `${sel.fromKey}..${sel.toKey}${sel.from ? `@${JSON.stringify(sel.from)}` : ''}`;
}

/**
 * Which version the lines between hunks are read from, for the diff's newer
 * side (`to`): the working tree (undefined: nothing picked, Uncommitted, Since
 * branch, a span to the working tree), `HEAD`, a commit (a parent point: the
 * commit before it), or a turn's snapshot of this repo — null when the turn
 * has none for it (the repo had no commit then). Pure.
 */
export function linesRef(
  to: DiffPoint | undefined,
  checkpointRepos: Record<string, string | null> | undefined,
  repo: string,
): string | null | undefined {
  if (!to || to.kind === 'working') return undefined;
  if (to.kind === 'head') return 'HEAD';
  if (to.kind === 'commit') return to.sha;
  if (to.kind === 'parent') return `${to.sha}^`;
  if (!checkpointRepos) return null;
  // A turn's snapshot is kept per repo root (its full path); the diff names a repo by its folder (as diff-points reads it).
  if (repo in checkpointRepos) return checkpointRepos[repo] ?? null;
  const key = Object.keys(checkpointRepos).find((root) => (root.split(/[\\/]/).filter(Boolean).pop() ?? root) === repo);
  return key ? (checkpointRepos[key] ?? null) : null;
}
