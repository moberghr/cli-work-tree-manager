// Finds path-looking pieces in a line of terminal text, and joins the terminal rows one long line was broken over.
// Pure on purpose: no imports, so the browser SPA can use it as well as the server.

/** A path-looking piece of `text`: [start, end) and the text itself, `:line` included. */
export interface PathRef {
  start: number;
  end: number;
  raw: string;
}

// Pieces are cut at whitespace and at characters that wrap a path in prose (commas, quotes, angle brackets).
// A space only stays inside a path as `%20` in a `file://` address.
const CHUNK = /[^\s,;"'`<>|]+/g;
const LEADING_WRAPPERS = '([{';
/** `[image]` (any `[word]`) right before an anchored path. */
const LABEL = /^\[[A-Za-z][\w -]*\](?=[/\\~.]|[A-Za-z]:[\\/])/;
const TRAILING_PUNCTUATION = '.,;:)]}"\'`>';
const LINE_SUFFIX = /(?::\d+){1,2}$/;
// A segment of a path: no spaces, no characters a file name cannot hold on Windows, no prose punctuation.
const SEGMENT_CHARS = /^[^\s:*?"<>|,;'`]+$/;
// `e.g`, `i.e`, `U.S`, `U.S.A`: letters separated by dots, not a file name.
const ABBREVIATION = /^(?:[A-Za-z]\.)+[A-Za-z]$/;
const HAS_EXTENSION = /^.+\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const BARE_NAME = /^[A-Za-z0-9_][\w-]*(?:\.[\w-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * Whether `base` (a piece without its `:line` suffix) is a path. The rules:
 * - `file://` addresses: always.
 * - Anchored paths (`/abs`, `~/x`, `C:\x`, `C:/x`, `./x`, `../x`): `~/`, `./`, `../` and a drive need one more segment; an
 *   absolute POSIX path needs two segments, or one with an extension (`/tmp` is prose, `/tmp/x` and `/a.txt` are paths).
 * - Relative with a separator and no leading dot-segment: the last segment has an extension (`src/web/x.tsx`), or it has at
 *   least three segments that each hold a letter (`src/web/components`). That keeps `and/or`, `input/output`, `w/o`,
 *   dates (`2026/11/25`) and fractions (`1/2`) out.
 * - No separator: a bare file name, `stem.ext` with a stem of 2+ characters and an extension of 1-8 letters/digits starting
 *   with a letter. That keeps versions (`v2.0.1`), decimals and abbreviations (`e.g.`) out; `node.js` is let through.
 */
function isPathLike(base: string): boolean {
  if (/^file:\/\//i.test(base)) return base.length > 'file://'.length;
  if (base.includes('://')) return false;

  let rest = base;
  let kind: 'posix' | 'anchored' | 'relative' = 'relative';
  if (/^[A-Za-z]:[\\/]/.test(base)) {
    rest = base.slice(3);
    kind = 'anchored';
  } else if (base.startsWith('~/')) {
    rest = base.slice(2);
    kind = 'anchored';
  } else if (/^\.{1,2}[\\/]/.test(base)) {
    rest = base.slice(base.search(/[\\/]/) + 1);
    kind = 'anchored';
  } else if (base.startsWith('/')) {
    rest = base.slice(1);
    kind = 'posix';
  }
  if (rest === '' || !SEGMENT_CHARS.test(rest.replace(/[\\/]/g, ''))) return false;

  const segs = rest.split(/[\\/]/).filter((s) => s !== '');
  if (segs.length === 0) return false;
  if (kind === 'anchored') return segs.some((s) => s !== '.' && s !== '..');
  if (kind === 'posix') return segs.length >= 2 || HAS_EXTENSION.test(segs[0]);

  if (/[\\/]/.test(base)) {
    if (HAS_EXTENSION.test(segs[segs.length - 1]) && segs.length >= 2) return true;
    return segs.length >= 3 && segs.every((s) => /[A-Za-z]/.test(s));
  }
  if (ABBREVIATION.test(base) || !BARE_NAME.test(base)) return false;
  return base.slice(0, base.lastIndexOf('.')).length >= 2;
}

export function findPathRefs(text: string): PathRef[] {
  const refs: PathRef[] = [];
  CHUNK.lastIndex = 0;
  for (let m = CHUNK.exec(text); m; m = CHUNK.exec(text)) {
    let start = m.index;
    let end = m.index + m[0].length;
    // A label stuck to the front of a path, as Claude Code prints an image it read: `[image]/tmp/shot.png`.
    const label = LABEL.exec(text.slice(start, end));
    if (label) start += label[0].length;
    while (start < end && LEADING_WRAPPERS.includes(text[start])) start++;
    while (end > start && TRAILING_PUNCTUATION.includes(text[end - 1])) end--;
    if (end <= start) continue;
    const raw = text.slice(start, end);
    // The line suffix is not part of what is checked: `SessionRail.tsx:202` is judged as `SessionRail.tsx`.
    const base = raw.replace(LINE_SUFFIX, '');
    if (isPathLike(base)) refs.push({ start, end, raw });
  }
  return refs;
}

/** `raw` without its `:line` / `:line:col`; a `file://` address decoded to a plain path. */
export function splitLine(raw: string): { path: string; line?: number } {
  let path = raw;
  let line: number | undefined;
  const m = /:(\d+)(?::\d+)?$/.exec(path);
  if (m) {
    path = path.slice(0, m.index);
    const n = Number(m[1]);
    if (n > 0) line = n;
  }
  const url = /^file:\/\/([^/]*)(\/.*)?$/i.exec(path);
  if (url) {
    path = url[2] ?? '/';
    try {
      path = decodeURIComponent(path);
    } catch {
      // A malformed percent sequence: keep the text as it is rather than guess.
    }
    // `file:///C:/x` is the Windows path `C:/x`.
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  }
  return line === undefined ? { path } : { path, line };
}

/** A terminal row: its text (right-trimmed) and whether xterm says it continues the row above (soft wrap). */
export interface TermRow {
  text: string;
  wrapped?: boolean;
}

/** rows[0] and the rows it continues onto, as one string, with where each character came from. */
export interface JoinedRows {
  text: string;
  map: Array<{ row: number; col: number }>;
  rows: number;
}

const MAX_JOINED_ROWS = 8;

/** The last piece of a row, when it holds a path separator. */
const PATH_TAIL = /[^\s,;"'`<>|]*[\\/][^\s,;"'`<>|]*$/;

/**
 * Whether `upper` continues onto `lower` — one logical line broken over two rows:
 * - `lower` is a soft wrap (xterm's `wrapped`);
 * - `upper` is (nearly) full and `lower` has text: Claude Code breaks long lines itself and indents the continuation;
 * - a path broken at one of its separators before the edge (reported: Claude Code put `…/scratchpad` on one row and
 *   `/pinned-full.png` on the next, the file's size at the end of that one, and neither half could be clicked): `upper`
 *   ends in a piece holding a separator, and either it ends with one or `lower` starts (after its indent) with one.
 * A join that makes a path that isn't there costs nothing: the pieces of each row are still tried (terminal-links.ts).
 */
export function rowContinues(upper: TermRow, lower: TermRow, cols: number): boolean {
  if (lower.wrapped) return true;
  if (!/\S/.test(lower.text)) return false;
  if (upper.text.length >= cols - 1) return true;
  const tail = PATH_TAIL.exec(upper.text)?.[0];
  if (!tail) return false;
  const head = lower.text.trimStart();
  return /[\\/]$/.test(tail) ? /^[^\s,;"'`<>|]/.test(head) : /^[\\/][^\s\\/]/.test(head);
}

/**
 * Joins rows[0] with the rows it continues onto (`rowContinues`); a continuation that isn't a soft wrap loses its indent.
 * Stops at the first row that does not continue, and at 8 rows.
 */
export function joinRows(rows: TermRow[], cols: number): JoinedRows {
  const joined: JoinedRows = { text: '', map: [], rows: 0 };
  if (rows.length === 0) return joined;

  const append = (row: number, from: number): void => {
    const text = rows[row].text;
    joined.text += text.slice(from);
    for (let col = from; col < text.length; col++) joined.map.push({ row, col });
    joined.rows = row + 1;
  };

  append(0, 0);
  while (joined.rows < rows.length && joined.rows < MAX_JOINED_ROWS) {
    const prev = rows[joined.rows - 1];
    const next = rows[joined.rows];
    if (!rowContinues(prev, next, cols)) break;
    append(joined.rows, next.wrapped ? 0 : next.text.length - next.text.trimStart().length);
  }
  return joined;
}
