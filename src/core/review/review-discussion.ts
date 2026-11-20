/**
 * PURE — a PR's existing discussion on its host (#64), as the Reviews tab
 * keeps, shows and hands it on: its shape check for state.db, its counts
 * for the overview, where each thread goes (on its line in the diff, or in
 * the list of outdated ones), when it's read again, and its text for the AI
 * step's prompt — others' words, fenced as data by the caller, open threads
 * first, within a budget. Shared with the SPA and the demo; keep it free of
 * anything but other pure modules.
 */

import type { PrDiscussionCommentWire, PrDiscussionThreadWire, PrDiscussionWire } from '../api-types.js';
import { asData } from '../time/fence.js';

/** The most of the discussion's text the AI step's prompt takes (the newest and open ones first). */
export const MAX_DISCUSSION_PROMPT = 8000;
/** The most of one comment the prompt takes. */
const MAX_PROMPT_COMMENT = 600;
/** Read again when the PR's host can't say it moved (no `updatedAt`), or open threads may have been resolved since. */
export const DISCUSSION_RECHECK_MS = 30 * 60_000;
/** Opening a review reads it again at most this often. */
export const DISCUSSION_OPEN_MIN_MS = 60_000;

const isComment = (v: unknown): v is PrDiscussionCommentWire => {
  const c = v as Partial<PrDiscussionCommentWire> | null;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.author === 'string' &&
    typeof c.body === 'string' &&
    typeof c.at === 'string' &&
    (c.association === undefined || typeof c.association === 'string') &&
    (c.url === undefined || typeof c.url === 'string')
  );
};

const isLine = (v: unknown) => v === null || (typeof v === 'number' && Number.isSafeInteger(v));

const isThread = (v: unknown): v is PrDiscussionThreadWire => {
  const t = v as Partial<PrDiscussionThreadWire> | null;
  return (
    !!t &&
    typeof t === 'object' &&
    typeof t.id === 'string' &&
    (t.path === null || typeof t.path === 'string') &&
    isLine(t.line) &&
    (t.originalLine === undefined || isLine(t.originalLine)) &&
    (t.side === 'right' || t.side === 'left') &&
    typeof t.outdated === 'boolean' &&
    typeof t.resolved === 'boolean' &&
    (t.url === undefined || typeof t.url === 'string') &&
    Array.isArray(t.comments) &&
    t.comments.every(isComment)
  );
};

const STATES = new Set(['approved', 'changes-requested', 'commented', 'dismissed']);

/** A stored discussion as written here; anything else is dropped (state.db's rows are shape-checked, never cast). */
export function isDiscussion(v: unknown): v is PrDiscussionWire {
  const d = v as Partial<PrDiscussionWire> | null;
  return (
    !!d &&
    typeof d === 'object' &&
    typeof d.at === 'string' &&
    (d.updatedAt === undefined || typeof d.updatedAt === 'string') &&
    (d.more === undefined || d.more === true) &&
    Array.isArray(d.threads) &&
    d.threads.every(isThread) &&
    Array.isArray(d.reviews) &&
    d.reviews.every((r) => isComment(r) && STATES.has((r as { state?: unknown }).state as string)) &&
    Array.isArray(d.comments) &&
    d.comments.every(isComment)
  );
}

export interface DiscussionCounts {
  threads: number;
  open: number;
  resolved: number;
  outdated: number;
  comments: number;
  /** Who approved, who asked for changes (each person once, their latest verdict). */
  approved: string[];
  changes: string[];
}

/** The overview's line: how many threads, how many open, and who approved or asked for changes (their latest verdict). */
export function discussionCounts(d: PrDiscussionWire): DiscussionCounts {
  const latest = new Map<string, string>();
  for (const r of [...d.reviews].sort((a, b) => a.at.localeCompare(b.at)))
    if (r.state === 'approved' || r.state === 'changes-requested' || r.state === 'dismissed') latest.set(r.author, r.state);
  const who = (s: string) => [...latest].filter(([, v]) => v === s).map(([k]) => k);
  return {
    threads: d.threads.length,
    open: d.threads.filter((t) => !t.resolved).length,
    resolved: d.threads.filter((t) => t.resolved).length,
    outdated: d.threads.filter((t) => t.outdated).length,
    comments: d.comments.length,
    approved: who('approved'),
    changes: who('changes-requested'),
  };
}

/** A thread's newest comment's time ('' when none says). */
const lastAt = (t: PrDiscussionThreadWire) => t.comments.reduce((m, c) => (c.at > m ? c.at : m), '');

/** Open threads first, each group newest first: the order the prompt and the lists take them in. */
export function threadOrder(threads: PrDiscussionThreadWire[]): PrDiscussionThreadWire[] {
  return [...threads].sort((a, b) => Number(a.resolved) - Number(b.resolved) || lastAt(b).localeCompare(lastAt(a)));
}

/** The lines a diff file shows, per side (a minimal ParsedFile: its hunks' line numbers). */
export interface ShownLines {
  path: string;
  hunks: Array<{ lines: Array<{ kind: string; oldNum?: number | null; newNum?: number | null }> }>;
}

/** Whether `file` shows `line` on `side`: the new side's added and context lines, the old side's deleted and context lines. */
export function showsLine(file: ShownLines, line: number, side: 'right' | 'left'): boolean {
  return file.hunks.some((h) =>
    h.lines.some((l) =>
      side === 'right' ? l.kind !== 'delete' && l.kind !== 'no-newline' && l.newNum === line : l.kind !== 'add' && l.oldNum === line,
    ),
  );
}

/**
 * Where each thread is shown: on its line in the diff (`inline`, keyed `path\nside\nline`), or in the list beside it
 * (`aside`): outdated, on no line (a whole file, or its line gone), or on a line the diff doesn't show.
 */
export function placeThreads(
  d: PrDiscussionWire | undefined,
  files: ShownLines[],
): { inline: Map<string, PrDiscussionThreadWire[]>; aside: PrDiscussionThreadWire[] } {
  const inline = new Map<string, PrDiscussionThreadWire[]>();
  const aside: PrDiscussionThreadWire[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const t of threadOrder(d?.threads ?? [])) {
    const f = t.path ? byPath.get(t.path) : undefined;
    if (!t.outdated && t.line !== null && f && showsLine(f, t.line, t.side)) {
      const k = lineKey(t.path!, t.side, t.line);
      inline.set(k, [...(inline.get(k) ?? []), t]);
    } else aside.push(t);
  }
  return { inline, aside };
}

/** The key a thread on a line is found by. */
export const lineKey = (path: string, side: 'right' | 'left', line: number) => `${path}\n${side}\n${line}`;

/** The threads per file (for the file tree's pill): open ones only. */
export function openThreadsByFile(d: PrDiscussionWire | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of d?.threads ?? []) if (t.path && !t.resolved) out.set(t.path, (out.get(t.path) ?? 0) + 1);
  return out;
}

/**
 * When the stored discussion is read again: never read; the PR moved on the host (its list's `updatedAt` isn't the
 * one it was read at); or, when the host's list can't say (`updatedAt` absent), or open threads may have been resolved
 * since (resolving doesn't move `updatedAt` on GitHub), once it's `DISCUSSION_RECHECK_MS` old.
 */
export function discussionDue(d: PrDiscussionWire | undefined, listedUpdatedAt: string | undefined, now: Date): boolean {
  if (!d) return true;
  if (listedUpdatedAt && d.updatedAt !== listedUpdatedAt) return true;
  const age = now.getTime() - Date.parse(d.at);
  if (!(age >= 0)) return true;
  const recheck = !listedUpdatedAt || d.threads.some((t) => !t.resolved);
  return recheck && age >= DISCUSSION_RECHECK_MS;
}

const who = (c: PrDiscussionCommentWire) => `@${asData(c.author, 60)}${c.association ? ` (${asData(c.association, 30)})` : ''}`;
const said = (c: PrDiscussionCommentWire) => asData(c.body, MAX_PROMPT_COMMENT);

/**
 * The discussion as the AI step's prompt lists it, within `max` characters: open threads first, then resolved ones
 * (each newest first), then the submitted reviews' verdicts and text, then the conversation comments (newest first) —
 * each item's text through `asData` (one line, no fence marker: the caller puts it between <<< and >>>). What didn't
 * fit is counted in a last line. Empty when there's nothing.
 */
export function discussionPromptLines(d: PrDiscussionWire | undefined, max = MAX_DISCUSSION_PROMPT): string[] {
  if (!d) return [];
  const items: string[] = [];
  for (const t of threadOrder(d.threads)) {
    const where = t.path
      ? `${asData(t.path, 200)}${t.line !== null ? `:${t.line}` : t.originalLine ? ` (was line ${t.originalLine})` : ''}${t.side === 'left' ? ' (old side)' : ''}`
      : 'the whole PR';
    const state = [t.resolved ? 'resolved' : 'open', t.outdated ? 'outdated' : ''].filter(Boolean).join(', ');
    const [first, ...rest] = t.comments;
    items.push(
      [`- Thread on ${where} [${state}]: ${who(first)}: ${said(first)}`, ...rest.map((c) => `  - reply ${who(c)}: ${said(c)}`)].join('\n'),
    );
  }
  const verdict = { approved: 'approved', 'changes-requested': 'requested changes', commented: 'commented', dismissed: 'dismissed' };
  for (const r of [...d.reviews].sort((a, b) => b.at.localeCompare(a.at)))
    if (r.body.trim() || r.state !== 'commented')
      items.push(`- Review by ${who(r)}: ${verdict[r.state]}${r.body.trim() ? `: ${said(r)}` : ''}`);
  for (const c of [...d.comments].sort((a, b) => b.at.localeCompare(a.at))) items.push(`- Comment by ${who(c)}: ${said(c)}`);
  const out: string[] = [];
  let room = max;
  let left = 0;
  for (const it of items) {
    if (it.length + 1 > room) {
      left++;
      continue;
    }
    room -= it.length + 1;
    out.push(it);
  }
  if (left) out.push(`- (${left} more not shown for room)`);
  return out;
}
