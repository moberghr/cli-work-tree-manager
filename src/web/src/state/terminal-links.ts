// Paths printed in a session's terminal as links (PtyView): the candidates on a row, which of them exist (asked of the
// server, cached), and the right-click menu of one. Pure: no React, no xterm, no fetch — PtyView passes those in.
import { findPathRefs, joinRows, splitLine, type TermRow } from '../../../core/worktree/terminal-path-refs.js';
import type { TerminalPathWire } from '../../../core/api-types.js';

/** The event a click on an ambiguous bare name sends: SessionDetail opens the code search with `query` typed in. */
export const CODE_SEARCH_EVENT = 'work:code-search';
export interface CodeSearchDetail {
  sessionId: string;
  query: string;
}

/** A terminal row: its text, whether xterm wrapped it from the row above, and where each character sits. */
export interface LinkRow extends TermRow {
  /** The cell column of each UTF-16 unit of `text`; absent: its index (a row without wide characters). */
  columns?: number[];
}

/** What readRow needs of xterm's IBufferLine (structural: this module does not import xterm). */
export interface BufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * A buffer line as a LinkRow, right-trimmed. Read cell by cell, not with translateToString: a wide character (an emoji,
 * CJK) is one character in two cells, and a link's range is in cells — without `columns` it would sit a cell off.
 */
export function readRow(line: BufferLineLike | undefined): LinkRow | undefined {
  if (!line) return undefined;
  let text = '';
  const columns: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    // The right half of a wide character: its left half has it.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || ' ';
    text += chars;
    for (let i = 0; i < chars.length; i++) columns.push(x);
  }
  text = text.trimEnd();
  columns.length = text.length;
  return { text, wrapped: line.isWrapped, columns };
}

/** A cell: 0-based column and row (the row numbering of `getRow`). */
export interface CellPos {
  x: number;
  y: number;
}

/** A path-looking piece of the screen, end inclusive. `joined`: it runs over more than one row. */
export interface LinkCandidate {
  raw: string;
  range: { start: CellPos; end: CellPos };
  joined: boolean;
}

/** A candidate the server found, with what it found. */
export interface PickedLink extends LinkCandidate {
  result: TerminalPathWire;
}

/** As joinRows: a logical line is at most this many rows. */
const MAX_ROWS = 8;

/** The rule joinRows joins by: the lower row is a soft wrap, or the upper is (nearly) full and the lower has text. */
function continues(upper: TermRow, lower: TermRow, cols: number): boolean {
  return !!lower.wrapped || (upper.text.length >= cols - 1 && /\S/.test(lower.text));
}

/** The first row of the logical line row `y` belongs to: up while the row above continues onto it, at most 8 rows. */
export function logicalStart(getRow: (y: number) => TermRow | undefined, y: number, cols: number): number {
  let start = y;
  for (let n = 1; n < MAX_ROWS; n++) {
    const above = getRow(start - 1);
    const row = getRow(start);
    if (!above || !row || !continues(above, row, cols)) break;
    start--;
  }
  return start;
}

const column = (row: LinkRow, index: number): number => row.columns?.[index] ?? index;

const sameRange = (a: LinkCandidate['range'], b: LinkCandidate['range']): boolean =>
  a.start.x === b.start.x && a.start.y === b.start.y && a.end.x === b.end.x && a.end.y === b.end.y;

/**
 * The paths that touch row `y`: those of its logical line joined (one running over rows is `joined`), then those of the
 * row's own text, unjoined — the pieces to fall back on when the joined path does not exist. A piece away from a row
 * break is the same as the joined line's and is listed once.
 */
export function rowLinkCandidates(getRow: (y: number) => LinkRow | undefined, y: number, cols: number): LinkCandidate[] {
  const own = getRow(y);
  if (!own) return [];
  const start = logicalStart(getRow, y, cols);
  const rows: LinkRow[] = [];
  for (let i = start; i < start + MAX_ROWS; i++) {
    const row = getRow(i);
    if (!row) break;
    rows.push(row);
  }
  const out: LinkCandidate[] = [];
  const add = (c: LinkCandidate) => {
    // The server refuses the whole request for one path longer than this (a wide terminal's joined rows can be).
    if (c.raw.length > MAX_PATH_CHARS) return;
    if (!out.some((o) => o.raw === c.raw && sameRange(o.range, c.range))) out.push(c);
  };

  const line = joinRows(rows, cols);
  for (const ref of findPathRefs(line.text)) {
    const first = line.map[ref.start];
    const last = line.map[ref.end - 1];
    const top = start + first.row;
    const bottom = start + last.row;
    if (y < top || y > bottom) continue;
    add({
      raw: ref.raw,
      range: { start: { x: column(rows[first.row], first.col), y: top }, end: { x: column(rows[last.row], last.col), y: bottom } },
      joined: bottom > top,
    });
  }
  for (const ref of findPathRefs(own.text)) {
    add({ raw: ref.raw, range: { start: { x: column(own, ref.start), y }, end: { x: column(own, ref.end - 1), y } }, joined: false });
  }
  return out;
}

/** The resolve route's limit per path (`MAX_TERMINAL_PATH_CHARS`, terminal-path-routes.ts). */
export const MAX_PATH_CHARS = 4096;
/** After a request that failed, nothing is asked for this long: a terminal that is no session answers 404 to every hover. */
export const FAILED_PAUSE_MS = 5000;

/** xterm's range: 1-based column and row, end inclusive. */
export function toXtermRange(range: LinkCandidate['range']): { start: CellPos; end: CellPos } {
  return { start: { x: range.start.x + 1, y: range.start.y + 1 }, end: { x: range.end.x + 1, y: range.end.y + 1 } };
}

/** Whether two ranges share a cell (row-major order). */
function overlaps(a: LinkCandidate['range'], b: LinkCandidate['range']): boolean {
  const before = (p: CellPos, q: CellPos) => p.y < q.y || (p.y === q.y && p.x < q.x);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/**
 * The candidates to show as links: those the server found (an ambiguous bare name too: it opens the code search). A joined
 * path that exists wins over the unjoined pieces it overlaps.
 */
export function pickLinks(candidates: LinkCandidate[], results: Map<string, TerminalPathWire>): PickedLink[] {
  const found: PickedLink[] = [];
  for (const c of candidates) {
    const result = results.get(c.raw);
    if (result && result.kind !== 'missing') found.push({ ...c, result });
  }
  const joined = found.filter((c) => c.joined);
  return found.filter((c) => c.joined || !joined.some((j) => overlaps(j.range, c.range)));
}

/** Raws asked about in one request (the resolve route's limit). */
export const MAX_PATHS_PER_REQUEST = 50;

export interface PathCache {
  /** Each raw's answer: from the cache while fresh, else asked (once, however many ask at the same time). */
  lookup(raws: string[]): Promise<Map<string, TerminalPathWire>>;
  clear(): void;
}

const missing = (raw: string): TerminalPathWire => ({ raw, path: null, kind: 'missing', opens: null });

/**
 * Which paths exist, remembered for `ttlMs`: hovering over the screen asks the server once per row, not per move. A
 * request that fails answers "missing" and is not remembered, so a later hover asks again — after `FAILED_PAUSE_MS`
 * (the terminal of something that is not a session gets 404s: no links, quietly, and not a request per move).
 */
export function createPathCache(
  resolve: (paths: string[]) => Promise<TerminalPathWire[]>,
  now: () => number = Date.now,
  ttlMs = 10_000,
): PathCache {
  const known = new Map<string, { at: number; result: TerminalPathWire }>();
  // null: the request failed.
  const asking = new Map<string, Promise<TerminalPathWire | null>>();
  // Bumped by clear(): an answer to a request from before it is not remembered.
  let generation = 0;
  let failedAt: number | null = null;

  const fresh = (raw: string, t: number) => {
    const k = known.get(raw);
    return !!k && t - k.at < ttlMs;
  };

  const ask = (batch: string[]) => {
    const asked = generation;
    const request = resolve(batch).then(
      (results) => results,
      () => {
        if (asked === generation) failedAt = now();
        return null;
      },
    );
    batch.forEach((raw, i) => {
      const one: Promise<TerminalPathWire | null> = request.then((results) => {
        if (asking.get(raw) === one) asking.delete(raw);
        if (!results) return null;
        const result = results[i] ?? missing(raw);
        if (asked === generation) known.set(raw, { at: now(), result });
        return result;
      });
      asking.set(raw, one);
    });
  };

  return {
    async lookup(raws) {
      const t = now();
      for (const [raw, k] of known) if (t - k.at >= ttlMs) known.delete(raw);
      const unique = [...new Set(raws)];
      const paused = failedAt !== null && t - failedAt < FAILED_PAUSE_MS;
      const need = paused ? [] : unique.filter((raw) => !fresh(raw, t) && !asking.has(raw));
      for (let i = 0; i < need.length; i += MAX_PATHS_PER_REQUEST) ask(need.slice(i, i + MAX_PATHS_PER_REQUEST));
      const answers = await Promise.all(
        unique.map((raw) => {
          const k = fresh(raw, t) ? known.get(raw) : undefined;
          return k ? k.result : asking.get(raw);
        }),
      );
      return new Map(unique.map((raw, i) => [raw, answers[i] ?? missing(raw)]));
    },
    clear() {
      known.clear();
      asking.clear();
      failedAt = null;
      generation++;
    },
  };
}

export type PathMenuId = 'show' | 'open' | 'editor' | 'reveal' | 'copy' | 'search';

/** What the pane beside the terminal draws (core/sessions/shown-file.ts `shownKind`): Markdown, HTML, an image. A click on
 *  one shows it there; the rest open as before. An SVG isn't one: drawn there it could run a script. */
export function showsBeside(file: string | null): boolean {
  const ext = (file ?? '').slice((file ?? '').lastIndexOf('.') + 1).toLowerCase();
  return ['md', 'markdown', 'mdx', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext);
}
export type Platform = 'mac' | 'windows' | 'other';

/** What a plain click ('click') or a menu pick does with a path: show it beside the terminal, open it, search for it,
 *  copy it. A click on a file the pane draws shows it there (falling back to open when the session can't show it). Pure. */
export function pathAction(id: PathMenuId | 'click', result: TerminalPathWire): PathMenuId {
  if (id !== 'click') return id;
  if (result.kind === 'ambiguous') return 'search';
  if (result.kind === 'file' && showsBeside(result.path)) return 'show';
  return 'open';
}

/** The right-click menu of a path: a file opens three ways, a folder is only revealed, an ambiguous name is searched for. */
export function pathMenuItems(result: TerminalPathWire, platform: Platform): Array<{ id: PathMenuId; label: string }> {
  const reveal = { id: 'reveal' as const, label: revealLabel(platform) };
  const copy = { id: 'copy' as const, label: 'Copy path' };
  switch (result.kind) {
    case 'file':
      return [
        ...(showsBeside(result.path) ? [{ id: 'show' as const, label: 'Show beside the terminal' }] : []),
        { id: 'open', label: 'Open' },
        { id: 'editor', label: 'Open in editor' },
        reveal,
        copy,
      ];
    case 'dir':
      return [reveal, copy];
    case 'ambiguous':
      return [{ id: 'search', label: `Search the code for “${bareName(result.raw)}”` }];
    default:
      return [];
  }
}

export function revealLabel(platform: Platform): string {
  if (platform === 'mac') return 'Reveal in Finder';
  if (platform === 'windows') return 'Show in Explorer';
  return 'Show in file manager';
}

/** A bare name as the code search takes it: without its `:line`. */
export function bareName(raw: string): string {
  return splitLine(raw).path;
}

/** The system, from `navigator.platform` or the user agent. */
export function platformOf(userAgentOrPlatform: string): Platform {
  if (/\bmac|iphone|ipad/i.test(userAgentOrPlatform)) return 'mac';
  // `\b`: Win32, Windows NT — not Darwin.
  if (/\bwin/i.test(userAgentOrPlatform)) return 'windows';
  return 'other';
}

/**
 * The toast for an open that failed: the server's `missing` / `ambiguous` said in words. `missing` is also the answer
 * for a path work does not look at (another machine's), so it does not claim the file was deleted.
 */
export function openFailure(raw: string, message: string): string {
  if (message === 'missing') return `Couldn’t open ${raw}: there is no such file here.`;
  if (message === 'ambiguous') return `Couldn’t open ${raw}: several files have that name.`;
  return `Couldn’t open ${raw}: ${message}`;
}
