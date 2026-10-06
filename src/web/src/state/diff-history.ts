import type { CheckpointEntry, DiffPoint, SessionCommit } from '../api/client.js';

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
}

export const UNCOMMITTED_KEY = 'u';

/**
 * Oldest first, what is uncommitted last. Commits are the repo's on screen
 * (`repo`; a commit belongs to one repo), turns cover every repo. A commit
 * and a turn at the same moment: the commit first, since the turn's
 * snapshot was taken after it.
 */
export function historyItems(entries: CheckpointEntry[], commits: SessionCommit[], repo: string | null): HistoryItem[] {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  // A turn is named by its checkpoint id (they count up from Initial's 0), so its
  // number never shifts. One whose predecessor is gone (the oldest turns are
  // dropped past MAX_CHECKPOINTS) isn't listed: diffed from Initial it would show
  // every dropped turn as its own. It stays inside spans and the branch's scope.
  const turns: HistoryItem[] = sorted.flatMap((e, i): HistoryItem[] =>
    i === 0 || sorted[i - 1].id !== e.id - 1
      ? []
      : [
          {
            key: `t:${e.id}`,
            kind: 'turn',
            title: e.label && e.label.trim() && e.label !== 'Initial' ? e.label.trim() : '',
            tag: `Turn ${e.id}`,
            at: e.ts,
            before: { kind: 'checkpoint', id: sorted[i - 1].id },
            after: { kind: 'checkpoint', id: e.id },
          },
        ],
  );
  const own: HistoryItem[] = commits
    .filter((c) => repo === null || c.repo === repo)
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
  if (sel.kind === 'scope') return sel.base === 'branch' || key === UNCOMMITTED_KEY;
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
export function sinceLooked(items: HistoryItem[], entries: CheckpointEntry[], seenId: number | null | undefined): DiffSelection | null {
  if (seenId === null || seenId === undefined) return null;
  const seen = entries.find((e) => e.id === seenId);
  if (!seen || !entries.some((e) => e.id > seenId)) return null;
  const seenAt = Date.parse(seen.ts);
  const first = items.find(
    (x) => x.kind !== 'uncommitted' && (x.after.kind === 'checkpoint' ? x.after.id > seenId : (Date.parse(x.at ?? '') || 0) > seenAt),
  );
  return {
    kind: 'range',
    fromKey: first?.key ?? UNCOMMITTED_KEY,
    toKey: UNCOMMITTED_KEY,
    from: { kind: 'checkpoint', id: seenId },
    label: 'Since you looked',
  };
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
