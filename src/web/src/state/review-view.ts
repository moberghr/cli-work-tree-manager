import type { PrReviewWire, ReviewDraftWire, ReviewFileWire, ReviewSummaryWire } from '../../../core/api-types.js';
import type { ParsedFile } from '../../../core/diff/diff-parse.js';
import type { Story, StoryFlag } from '../../../core/review/review-plan.js';
import { FOLDED_KINDS, KIND_LABEL, KIND_ORDER, type ChangeKind } from '../../../core/review/change-kinds.js';
import { fixStateRefusal } from '../../../core/review/review-fix-rules.js';

/**
 * PURE — how the Reviews tab lays a review out (#64). Three ways to read it:
 * the **overview** (what it does in short, the comments waiting for you, the
 * stories as cards, what nothing tests, what isn't worth reading); one
 * **story** at a time (its reasoning, its code files' diffs, its tests folded
 * into one line) — the kinds of change that aren't in a story (API, schema,
 * wiring, …) are pages after the stories in the same pager, the generated and
 * mechanical ones folded; and a **walk through the comments**, one at a time
 * with the code around it. And the list of reviews, by repo.
 */

export interface ReviewEntry {
  path: string;
  added: number;
  deleted: number;
  status: string;
  /** Where a renamed file came from. */
  oldPath?: string;
  /** Why it's where it is: the rule that put it in its kind, or "tests …" for a story's test. */
  why: string;
  role: 'code' | 'test';
  /** What changed in it and why it matters (the AI step's; absent: none). */
  summary?: string;
}

/** One page of the story pager: a story, or a kind of change no story took. */
export interface ReviewPage {
  key: string;
  label: string;
  story?: Story;
  kind?: ChangeKind;
  /** Generated or mechanical: its diffs folded until asked. */
  folded: boolean;
  /** The files to read, in the review's order. */
  code: ReviewEntry[];
  /** A story's tests: every test file of the PR that covers one of its files (a test file can cover two stories). */
  tests: ReviewEntry[];
  /** Its tests' cases (not the removed ones): how many, added, changed; and the files they're in. */
  testCounts: { tests: number; added: number; changed: number; files: number };
}

const baseName = (p: string) => p.split('/').pop() ?? p;

/** The pager's pages: the stories (riskiest first), then each kind of change with files no story took. */
export function reviewPages(r: PrReviewWire): ReviewPage[] {
  const byPath = new Map(r.files.map((f) => [f.path, f]));
  const placed = new Set<string>();
  const entry = (f: ReviewFileWire, role: ReviewEntry['role'], why?: string): ReviewEntry => ({
    path: f.path,
    added: f.added,
    deleted: f.deleted,
    status: f.status,
    ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    why: why ?? f.why,
    role,
    ...(f.summary ? { summary: f.summary } : {}),
  });
  const covering = new Set<string>();
  const pages: ReviewPage[] = r.stories.map((s, i) => {
    const code = s.files
      .filter((p) => byPath.has(p) && !placed.has(p))
      .map((p) => {
        placed.add(p);
        return entry(byPath.get(p)!, 'code');
      });
    const tests = Object.entries(r.tests.covers)
      .filter(([t, covered]) => byPath.has(t) && covered.some((p) => s.files.includes(p)))
      .map(([t, covered]) => {
        covering.add(t);
        return entry(
          byPath.get(t)!,
          'test',
          `tests ${covered
            .filter((p) => s.files.includes(p))
            .map(baseName)
            .join(', ')}`,
        );
      });
    const files = new Set(tests.map((t) => t.path));
    const cases = r.tests.list.filter((t) => files.has(t.file) && t.change !== 'removed');
    return {
      key: `story-${i}`,
      label: s.title,
      story: s,
      folded: false,
      code,
      tests,
      testCounts: {
        tests: cases.length,
        added: cases.filter((t) => t.change === 'added').length,
        changed: cases.filter((t) => t.change === 'changed').length,
        files: tests.length,
      },
    };
  });
  for (const kind of KIND_ORDER) {
    const files = r.files.filter((f) => f.kind === kind && !placed.has(f.path) && !(kind === 'tests' && covering.has(f.path)));
    if (!files.length) continue;
    for (const f of files) placed.add(f.path);
    pages.push({
      key: `kind-${kind}`,
      label: KIND_LABEL[kind],
      kind,
      folded: FOLDED_KINDS.has(kind),
      code: files.map((f) => entry(f, kind === 'tests' ? 'test' : 'code')),
      tests: [],
      testCounts: { tests: 0, added: 0, changed: 0, files: 0 },
    });
  }
  return pages;
}

/** The page a file is read on (its code, else a story's tests), or -1. */
export function pageOf(pages: ReviewPage[], path: string): number {
  const code = pages.findIndex((p) => p.code.some((e) => e.path === path));
  return code >= 0 ? code : pages.findIndex((p) => p.tests.some((e) => e.path === path));
}

/** The one line a story's tests fold into: "40 tests cover this · 39 added · 1 changed" (none: said so). */
export function testsLine(p: ReviewPage): string {
  const c = p.testCounts;
  if (!c.files) return 'No test of this PR covers it';
  const parts = [
    c.tests
      ? `${c.tests} test${c.tests === 1 ? '' : 's'} in ${c.files} file${c.files === 1 ? '' : 's'} cover this`
      : `${c.files} test file${c.files === 1 ? '' : 's'} cover this`,
    ...(c.added ? [`${c.added} added`] : []),
    ...(c.changed ? [`${c.changed} changed`] : []),
  ];
  return parts.join(' · ');
}

export interface StoryCard {
  /** Its page in the pager. */
  page: number;
  /** 1-based: "Story 2". */
  number: number;
  title: string;
  /** What it does, whole (the card's tooltip), and its first sentence (shown); absent for a story without one. */
  what?: string;
  lead?: string;
  riskLevel: number;
  flags: StoryFlag[];
  codeFiles: number;
  comments: number;
  /**
   * How its tests stand: "30 tests", and — when some of its code files are among the files no test touches (the
   * Untested list) — "1 file untested", so the card never contradicts that list.
   */
  tests: { state: 'covered' | 'gap' | 'unit-only'; text: string; untested: string | null };
}

/** The overview's story cards: number, title, what it does, risk, flags, files, comments, and how its tests stand. */
export function storyCards(r: PrReviewWire, pages: ReviewPage[]): StoryCard[] {
  const drafts = pendingDrafts(r);
  const kindOf = new Map(r.files.map((f) => [f.path, f.kind]));
  const untested = new Set(r.tests.gaps);
  return pages.flatMap((p, i) => {
    const s = p.story;
    if (!s) return [];
    const files = new Set(p.code.map((e) => e.path));
    const tests = new Set(p.tests.map((e) => e.path));
    const cases = r.tests.list.filter((t) => tests.has(t.file) && t.change !== 'removed');
    const schema = s.files.some((f) => kindOf.get(f) === 'schema');
    const state: StoryCard['tests']['state'] = !p.tests.length
      ? 'gap'
      : schema && cases.length > 0 && cases.every((t) => t.level === 'unit')
        ? 'unit-only'
        : 'covered';
    const n = cases.length || p.tests.length;
    const gaps = state === 'gap' ? 0 : p.code.filter((e) => untested.has(e.path)).length;
    return [
      {
        page: i,
        number: i + 1,
        title: s.title,
        ...(s.what ? { what: s.what, lead: gist(s.what, 280) } : {}),
        riskLevel: s.riskLevel,
        flags: s.flags,
        codeFiles: p.code.length,
        comments: drafts.filter((d) => files.has(d.path)).length,
        tests: {
          state,
          text: state === 'gap' ? 'no tests' : state === 'unit-only' ? `${n} unit tests only` : `${n} test${n === 1 ? '' : 's'}`,
          untested: gaps ? `${gaps} file${gaps === 1 ? '' : 's'} untested` : null,
        },
      },
    ];
  });
}

/** "In short": the AI step's summary, or — none (an older review, no AI step) — the story titles as bullets. */
export function inShort(r: PrReviewWire): { summary: string } | { bullets: string[] } {
  return r.summary ? { summary: r.summary } : { bullets: r.stories.map((s) => s.title) };
}

/** The overview's folded line: what isn't worth reading — generated files, translations, mechanical changes — and the files. */
export function notWorthReading(
  r: PrReviewWire,
): { line: string; files: ReviewFileWire[]; ignored: NonNullable<PrReviewWire['ignored']> } | null {
  // Left out of the review altogether (designer files): named here, never diffed.
  const ignored = r.ignored ?? [];
  const generated = r.files.filter((f) => f.kind === 'generated');
  const translations = r.files.filter((f) => f.kind === 'mechanical' && /translation|resource/i.test(f.why));
  const mechanical = r.files.filter((f) => f.kind === 'mechanical' && !translations.includes(f));
  const parts = [
    generated.length ? `${generated.length} generated` : '',
    translations.length ? `${translations.length} translation${translations.length === 1 ? '' : 's'}` : '',
    mechanical.length ? `${mechanical.length} mechanical` : '',
    ignored.length ? `${ignored.length} designer file${ignored.length === 1 ? '' : 's'} left out` : '',
  ].filter(Boolean);
  if (!parts.length) return null;
  return { line: parts.join(' · '), files: [...generated, ...translations, ...mechanical], ignored };
}

/** The drafts that would go out with the review (not posted yet). */
export const pendingDrafts = (r: PrReviewWire) => r.drafts.filter((d) => d.state === 'draft');

/** The drafts in the review's order: by the page their file is read on, then the file's place there, then the line. */
export function commentWalk(r: PrReviewWire, pages: ReviewPage[]): ReviewDraftWire[] {
  const order = new Map<string, number>();
  pages.forEach((p, i) => [...p.code, ...p.tests].forEach((e, j) => order.has(e.path) || order.set(e.path, i * 10_000 + j)));
  const at = (d: ReviewDraftWire) => order.get(d.path) ?? Number.MAX_SAFE_INTEGER;
  return pendingDrafts(r)
    .map((d, i) => ({ d, i }))
    .sort((a, b) => at(a.d) - at(b.d) || a.d.line - b.d.line || a.i - b.i)
    .map((x) => x.d);
}

/** A comment's first sentence (at most `max` characters, cut at a word): its gist on one line. */
export function gist(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const m = flat.match(/^.+?[.!?](?=\s|$)/);
  const first = m ? m[0] : flat;
  if (first.length <= max) return first;
  const room = first.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max * 0.6 ? room.slice(0, space) : room).replace(/[\s,;:.–—-]+$/, '')}…`;
}

/** "CreateMerchantCommand.cs:169" — where a comment is, short. */
export const shortWhere = (d: { path: string; line: number }) => `${baseName(d.path)}:${d.line}`;

/** A file's change as a letter in a coloured badge, GitHub's way: A added, M modified, D deleted, R renamed, B binary. */
export type ChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';
export function changeType(f: { status: string; oldPath?: string }): { type: ChangeType; letter: string; label: string } {
  const type: ChangeType =
    f.status === 'added' || f.status === 'deleted' || f.status === 'renamed' || f.status === 'binary'
      ? f.status
      : f.oldPath && f.status === 'modified'
        ? 'renamed'
        : 'modified';
  const label =
    type === 'renamed' && f.oldPath
      ? `Renamed from ${f.oldPath}`
      : { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', binary: 'Binary' }[type];
  return { type, letter: type.charAt(0).toUpperCase(), label };
}

/**
 * GitHub's diffstat: five blocks, green for the added share, red for the deleted, grey for what's left. A change of
 * fewer than five lines fills that many; each side with any line keeps at least one block.
 */
export function diffstatBlocks(added: number, deleted: number, blocks = 5): Array<'add' | 'del' | 'none'> {
  const total = added + deleted;
  const filled = Math.min(blocks, total);
  let add = total ? Math.round((filled * added) / total) : 0;
  if (added > 0 && add === 0) add = 1;
  if (deleted > 0 && filled - add === 0 && filled > 1) add = filled - 1;
  const del = filled - add;
  return [...Array<'add'>(add).fill('add'), ...Array<'del'>(del).fill('del'), ...Array<'none'>(blocks - filled).fill('none')];
}

/** The draft comments still to go out, per file. */
export function commentsByFile(r: PrReviewWire): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of pendingDrafts(r)) out.set(d.path, (out.get(d.path) ?? 0) + 1);
  return out;
}

/**
 * The file whose diff is on screen: the last one whose top has reached `line` (the pane's top plus a little), else the
 * first. `tops` in the page's order, measured against the same origin as `line`.
 */
export function fileOnScreen(tops: Array<{ path: string; top: number }>, line: number): string | null {
  let at: string | null = tops[0]?.path ?? null;
  for (const t of tops) if (t.top <= line) at = t.path;
  return at;
}

/** A file as the story view's tree shows it: its name whole, its folder apart (dimmed). */
export function splitPath(path: string): { name: string; folder: string } {
  const i = path.lastIndexOf('/');
  return i < 0 ? { name: path, folder: '' } : { name: path.slice(i + 1), folder: path.slice(0, i) };
}

/**
 * A file name in the places it may wrap — before each capital of a CamelCase word and after a dot, `_` or `-` — so a
 * long C# name breaks into words in a narrow tree rather than mid-word: "Create|Merchant|Command.cs". The extension
 * stays with the word before it (never "Controller." with "cs" alone on the next line).
 */
export function nameParts(name: string): string[] {
  const parts = name.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[._-])/).filter(Boolean);
  const last = parts.length - 1;
  if (last > 0 && parts[last - 1].endsWith('.') && !parts[last].includes('.')) parts.splice(last - 1, 2, parts[last - 1] + parts[last]);
  return parts;
}

/**
 * A folder in the places it may wrap — after each `/`, never inside a folder's name: "src/|Payfac.Services.Admin/|
 * Handlers". The views draw a break opportunity between the parts and let no word break (`.wd-review-folder`).
 */
export function folderParts(folder: string): string[] {
  return folder.split(/(?<=\/)/).filter(Boolean);
}

/**
 * The AI step's prose in parts: what it put between backticks is code (`CreateBankAccount`), drawn as such, the rest
 * plain text — never Markdown beyond that. A backtick without its pair stays as it is.
 */
export function proseParts(text: string): Array<{ text: string; code?: true }> {
  const out: Array<{ text: string; code?: true }> = [];
  const re = /`([^`\n]+)`/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[1], code: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The AI step's prose as plain text (a tooltip): the backticks around code dropped. */
export const plainProse = (text: string) =>
  proseParts(text)
    .map((p) => p.text)
    .join('');

/** A page's label short enough for a button ("Next: …"): its first sentence, cut at a word. */
export const shortLabel = (label: string, max = 90) => gist(label, max);

/**
 * The code around a comment: its file cut to the hunk lines within `radius` lines of the commented one (both sides of
 * the hunk — deleted lines too), as a file of one hunk the diff view draws. Null when the line isn't in the diff.
 */
export function commentContext(file: ParsedFile, line: number, radius = 7): ParsedFile | null {
  for (const h of file.hunks) {
    const at = h.lines.findIndex((l) => l.newNum === line && l.kind !== 'delete');
    if (at < 0) continue;
    const lines = h.lines.slice(Math.max(0, at - radius), at + radius + 1).filter((l) => l.kind !== 'no-newline');
    const firstOld = lines.find((l) => l.oldNum !== null)?.oldNum ?? h.oldStart;
    const firstNew = lines.find((l) => l.newNum !== null)?.newNum ?? h.newStart;
    const hunk = {
      oldStart: firstOld,
      oldLines: lines.filter((l) => l.kind !== 'add').length,
      newStart: firstNew,
      newLines: lines.filter((l) => l.kind !== 'delete').length,
      context: h.context,
      lines,
    };
    return {
      ...file,
      added: lines.filter((l) => l.kind === 'add').length,
      deleted: lines.filter((l) => l.kind === 'delete').length,
      hunks: [hunk],
      mdContent: undefined,
    };
  }
  return null;
}

/** Files viewed of a set of entries: "3 / 6". */
export function viewedCount(entries: ReviewEntry[], viewed: ReadonlySet<string>): { viewed: number; total: number } {
  return { viewed: entries.filter((e) => viewed.has(e.path)).length, total: entries.length };
}

/** The whole review's progress: the code files of every page worth reading (not the generated or mechanical ones). */
export function reviewProgress(pages: ReviewPage[], viewed: ReadonlySet<string>): { viewed: number; total: number } {
  return viewedCount(
    pages.filter((p) => !p.folded).flatMap((p) => p.code),
    viewed,
  );
}

/** The reviews by repo (the newest push first within each, repos by their newest), or as one list. */
export function groupReviews(
  list: ReviewSummaryWire[],
  by: 'repo' | 'none',
): Array<{ repo: string | null; host?: string; reviews: ReviewSummaryWire[] }> {
  const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at));
  if (by === 'none') return [{ repo: null, reviews: sorted }];
  const groups = new Map<string, ReviewSummaryWire[]>();
  for (const r of sorted) groups.set(r.repo, [...(groups.get(r.repo) ?? []), r]);
  return [...groups].map(([repo, reviews]) => ({ repo, ...(reviews[0].host ? { host: reviews[0].host } : {}), reviews }));
}

/**
 * Why Fix it myself can't be offered now (null: it can) — the button disabled with this as its reason: the server's own
 * rule (`fixStateRefusal`, shared: a fork's branch isn't on origin; a submit in doubt or under way, or a Fix it myself
 * making its session, speaks for the drafts; a new push being prepared), or nothing to take off.
 */
/**
 * What the page says where a review would be, while none is prepared (reported: a PR held for its size opened on a
 * blank page): why, and what you can do — Prepare it now, or the verdict buttons below, which need nothing prepared.
 * Null once it's ready. Pure.
 */
export function notPreparedLine(r: Pick<PrReviewWire, 'status' | 'held' | 'why'>): string | null {
  switch (r.status) {
    case 'ready':
      return null;
    case 'queued':
      return 'In line to be prepared: it shows here once it is.';
    case 'running':
      return 'Being prepared: its stories and comments show here when it’s done.';
    case 'failed':
      return `Preparing it failed${r.why ? ` (${r.why})` : ''}. Prepare it now tries again; you can still approve or comment below.`;
    case 'waiting':
      return r.held === 'cap'
        ? 'Not prepared yet: the day’s automatic reviews are done. Prepare it now reads it anyway; you can still approve or comment below.'
        : 'Not prepared: it changes more lines to read than the size limit lets a sweep take by itself (Settings → Reviews). Prepare it now reads it anyway; you can still approve or comment below.';
  }
}

export function fixMyselfBlocked(r: PrReviewWire, now: Date = new Date()): string | null {
  const why = fixStateRefusal(r, now)?.error;
  if (why) return why.charAt(0).toUpperCase() + why.slice(1);
  if (!pendingDrafts(r).length) return 'No draft comments to fix';
  return null;
}

/** "3 comments being fixed in feat/x" — each batch Fix it myself took off, named by its session (`nameOf`) or branch. */
export function fixingLines(r: PrReviewWire, nameOf: (id: string) => string | null): Array<{ sessionId: string; text: string }> {
  return (r.fixingMyself ?? []).map((f) => ({
    sessionId: f.sessionId,
    text: `${f.comments.length} comment${f.comments.length === 1 ? '' : 's'} being fixed in ${nameOf(f.sessionId) ?? f.branch}`,
  }));
}

/** A node of the Files view's tree: a folder (its single-folder chain joined, `src/Shop.Orders`) or a file. */
export type FileNode =
  { kind: 'folder'; name: string; path: string; children: FileNode[] } | { kind: 'file'; name: string; path: string; file: ReviewFileWire };

/**
 * The Files view (GitHub's "Files changed"): every file of the PR as a folder tree — folders first, then files, each
 * by name ignoring case; a folder holding only one folder joined with it — and the files in that tree's order, which
 * is the order their diffs are read in.
 */
export function filesTree(files: ReviewFileWire[]): { nodes: FileNode[]; order: string[] } {
  type Dir = { dirs: Map<string, Dir>; files: ReviewFileWire[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let at = root;
    for (const p of parts.slice(0, -1)) {
      if (!at.dirs.has(p)) at.dirs.set(p, { dirs: new Map(), files: [] });
      at = at.dirs.get(p)!;
    }
    at.files.push(f);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
  const order: string[] = [];
  const walk = (dir: Dir, prefix: string): FileNode[] => {
    const folders = [...dir.dirs.keys()].sort(byName).map((name): FileNode => {
      let sub = dir.dirs.get(name)!;
      let label = name;
      // A folder that holds only one folder (and no file) reads as one: `src/Shop.Orders`.
      while (sub.files.length === 0 && sub.dirs.size === 1) {
        const [only, next] = [...sub.dirs][0];
        label = `${label}/${only}`;
        sub = next;
      }
      const path = prefix ? `${prefix}/${label}` : label;
      return { kind: 'folder', name: label, path, children: walk(sub, path) };
    });
    const leaves = [...dir.files]
      .sort((a, b) => byName(splitPath(a.path).name, splitPath(b.path).name))
      .map((f): FileNode => ({ kind: 'file', name: splitPath(f.path).name, path: f.path, file: f }));
    return [...folders, ...leaves];
  };
  const nodes = walk(root, '');
  // The diffs are read in the tree's order: folders first at each level.
  const visit = (ns: FileNode[]) => ns.forEach((n) => (n.kind === 'file' ? order.push(n.path) : visit(n.children)));
  visit(nodes);
  return { nodes, order };
}

/** The Files view's diffs folded until asked (as GitHub folds generated files): generated files. */
export const foldedInFiles = (f: Pick<ReviewFileWire, 'kind'>) => f.kind === 'generated';

/** "12 / 48 viewed": every file of the PR, ticked in the Files view or the stories (the same ticks). */
export function filesViewed(r: PrReviewWire, viewed: ReadonlySet<string>): { viewed: number; total: number } {
  return { viewed: r.files.filter((f) => viewed.has(f.path)).length, total: r.files.length };
}

/**
 * Someone's Markdown comment (a PR's discussion on its host) on one line: HTML comments and tags, headings' `#`,
 * emphasis, quote marks, list bullets and tables' rows dropped — what it says, not how it's marked up — then its gist.
 */
export function mdGist(body: string, max = 140): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l))
    .map((l) => l.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/, ''))
    .join(' ')
    .replace(/\*\*|__|~~/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  return gist(text, max);
}
