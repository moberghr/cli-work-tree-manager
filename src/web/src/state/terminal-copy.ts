import { escapeHtml, styleTables } from './rich-copy.js';

/**
 * Text copied from a session's terminal, put back together. Claude Code
 * draws its replies wrapped at the screen's width, indented under its "●",
 * padded out with spaces — so a copied paragraph came out chopped into
 * lines ("This is cheap and" / "     fixes most cases."), every line
 * indented. This undoes what the drawing did:
 *
 *  - trailing spaces go;
 *  - Claude Code's gutter markers (●, ⏺, ⎿) go, keeping their columns;
 *  - a line that was broken only because the next word didn't fit is joined
 *    with the next one: the line plus a space plus that word would have run
 *    past the screen's width, and the next line carries on the same text
 *    (indented as its continuation, not a list item or heading of its own);
 *  - the indentation every line shares goes.
 *
 * A guess, but a careful one: a line whose next word would have fit was
 * broken on purpose, and stays broken (code, lists, short lines). Pure.
 */

const MARKER = /^(\s*)([●⏺⎿])(\s)/u;
/** A line that starts something of its own: a list item, a heading, a quote, a table or box row. */
const STARTS_ITS_OWN = /^(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s|>\s|[│┃|┌└├╭╰─━])/u;
const LIST_ITEM = /^(?:[-*+•]|\d+[.)])\s+/u;

const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * Style marks in the text, from the terminal's cells (`markedSelection`):
 * bold on/off, italic on/off — private-use characters nothing types. Every
 * measurement reads the text without them (`plain`); each line opens and
 * closes its own, so joining lines keeps them balanced.
 */
const B_ON = '\uE000';
const B_OFF = '\uE001';
const I_ON = '\uE002';
const I_OFF = '\uE003';
const MARKS = /[\uE000-\uE003]/gu;
export const plain = (s: string): string => s.replace(MARKS, '');

/** `raw` without its first `n` whitespace characters (marks among them stay). */
function dropLead(raw: string, n: number): string {
  let out = '';
  let i = 0;
  for (; i < raw.length && n > 0; i++) {
    if (/[\uE000-\uE003]/u.test(raw[i])) out += raw[i];
    else if (/\s/u.test(raw[i])) n--;
    else break;
  }
  return out + raw.slice(i);
}
const trimLead = (raw: string) => dropLead(raw, indentOf(plain(raw)));

/** `cleanTerminalCopy` with the style marks kept: what `terminalCopy` makes its HTML from. */
function cleanMarked(text: string, cols: number, firstCol: number): string {
  // Gutter markers become spaces, so every line keeps its columns for the width test.
  const lines = text.split(/\r?\n/).map((l) => {
    const r = l.replace(/\s+$/u, '');
    return MARKER.test(plain(r)) ? r.replace(/[●⏺⎿]/u, ' ') : r;
  });
  const col0 = (i: number) => (i === 0 ? firstCol : 0);
  const out: string[] = [];
  // Each output line keeps where it started and the indent its continuation lines have.
  let cur: { text: string; cont: number; end: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const v = plain(l);
    const body = trimLead(l);
    const vbody = v.trimStart();
    const indent = col0(i) + indentOf(v);
    const end = col0(i) + v.length; // the column its last character ended at
    if (
      cur &&
      vbody &&
      cur.end + 1 + (vbody.split(/\s/u)[0]?.length ?? 0) > cols - 2 &&
      !STARTS_ITS_OWN.test(vbody) &&
      indent === cur.cont
    ) {
      cur.text += ' ' + body;
      cur.end = end;
      continue;
    }
    if (cur) out.push(cur.text);
    if (!vbody) {
      cur = null;
      out.push('');
      continue;
    }
    const item = LIST_ITEM.exec(vbody);
    cur = { text: (i === 0 ? '' : ' '.repeat(indentOf(v))) + body, cont: indent + (item ? item[0].length : 0), end };
    // A line that is a table or box row never takes the next one in.
    if (/[│┃]/u.test(vbody)) {
      out.push(cur.text);
      cur = null;
    }
  }
  if (cur) out.push(cur.text);
  // The indentation every line shares (the first line's selection may have started past it).
  const rest = out.slice(1).filter((l) => plain(l).trim());
  const shared = rest.length ? Math.min(...rest.map((l) => indentOf(plain(l)))) : 0;
  return out.map((l, i) => (i === 0 ? trimLead(l) : dropLead(l, Math.min(shared, indentOf(plain(l)))))).join('\n');
}

/**
 * @param cols the terminal's width in columns.
 * @param firstCol the column the selection started at: its first line's text began there, not at 0.
 */
export function cleanTerminalCopy(text: string, cols: number, firstCol = 0): string {
  return plain(cleanMarked(text, cols, firstCol));
}

/** What `markedSelection` reads of a terminal cell (xterm's IBufferCell). */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
  isBold(): number;
  isItalic(): number;
}
/** What it reads of the terminal's buffer (xterm's IBuffer). */
export interface BufferLike {
  getLine(y: number): { isWrapped: boolean; length: number; getCell(x: number): CellLike | undefined } | undefined;
}

/**
 * The selected text with bold and italic marked, from the terminal's cells
 * — `getSelection` gives the characters alone. Rows the terminal wrapped
 * itself are joined as it joins them; each row closes the styles it opened.
 * `range` as xterm's `getSelectionPosition` has it: 0-based, the end column
 * not included.
 */
export function markedSelection(buf: BufferLike, range: { start: { x: number; y: number }; end: { x: number; y: number } }): string {
  let out = '';
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buf.getLine(y);
    if (!line) break;
    const wrapsOn = y < range.end.y && !!buf.getLine(y + 1)?.isWrapped;
    const cells: Array<{ ch: string; b: boolean; i: boolean }> = [];
    const to = y === range.end.y ? Math.min(range.end.x, line.length) : line.length;
    for (let x = y === range.start.y ? range.start.x : 0; x < to; x++) {
      const c = line.getCell(x);
      if (!c || c.getWidth() === 0) continue; // the second half of a wide character
      cells.push({ ch: c.getChars() || ' ', b: !!c.isBold(), i: !!c.isItalic() });
    }
    // Trailing blanks go, unless the row runs on into the next (a space at the wrap is the text's).
    let last = cells.length;
    if (!wrapsOn) while (last > 0 && cells[last - 1].ch.trim() === '') last--;
    let b = false;
    let it = false;
    for (const c of cells.slice(0, last)) {
      // A blank takes no style of its own: runs don't open on the spaces between words.
      const wantB: boolean = c.ch.trim() ? c.b : b;
      const wantI: boolean = c.ch.trim() ? c.i : it;
      // A change closes what's open and opens what's wanted, italic inside bold: the tags never cross.
      if (wantB !== b || wantI !== it) {
        if (it) out += I_OFF;
        if (b) out += B_OFF;
        if (wantB) out += B_ON;
        if (wantI) out += I_ON;
        b = wantB;
        it = wantI;
      }
      out += c.ch;
    }
    if (it) out += I_OFF;
    if (b) out += B_OFF;
    if (y < range.end.y && !wrapsOn) out += '\n';
  }
  return out;
}

/** What `selectionText` reads of the terminal (xterm's Terminal). */
export interface TerminalLike {
  getSelection(): string;
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  buffer: { active: BufferLike };
}

/**
 * The terminal's selection with its bold and italic marked
 * (`markedSelection`) — or the plain selection when the two don't read the
 * same text (a column selection, a buffer that moved): a copy never loses
 * text to its styles.
 */
export function selectionText(term: TerminalLike): string {
  const text = term.getSelection();
  const range = term.getSelectionPosition();
  if (!range) return text;
  const marked = markedSelection(term.buffer.active, range);
  // xterm ends its lines with \r\n on Windows (every multi-line selection lost its styles to that); trailing blanks aside.
  const same = (s: string) => s.replace(/\r\n/gu, '\n').replace(/[ \t]+$/gmu, '');
  return same(plain(marked)) === same(text) ? marked : text;
}

/** A marked line as HTML: escaped, its marks as <b>/<i>, a run broken only by a space joined. */
function styledHtml(line: string): string {
  let html = escapeHtml(line)
    .replaceAll(B_ON, '<b>')
    .replaceAll(B_OFF, '</b>')
    .replaceAll(I_ON, '<i>')
    .replaceAll(I_OFF, '</i>')
    .replace(/<\/b>(\s*)<b>/gu, '$1')
    .replace(/<\/i>(\s*)<i>/gu, '$1');
  // A run that took the space after its last word: its tags close before it (again, past each closing tag).
  for (let prev = ''; prev !== html;) {
    prev = html;
    html = html.replace(/(\s+)(<\/[bi]>)/gu, '$2$1');
  }
  return html;
}

/** A table row as drawn: `│ a │ b │` (Claude Code's tables) or `| a | b |` (Markdown it printed as is). */
const TABLE_ROW = /^\s*[│┃|].*[│┃|]\s*$/u;
/** A table's rule: `┌──┬──┐`, `├──┼──┤`, `└──┴──┘`, or Markdown's `|---|:--|`. */
const TABLE_RULE = /^\s*(?:[┌├└╭╰┏┣┗┡╞][─━┬┼┴┳╋┻┐┤┘╮╯┓┫┛┩╡═╪╤╧\s]*|\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?)$/u;

const cellsOf = (row: string) =>
  row
    .trim()
    .replace(/^[│┃|]|[│┃|]$/gu, '')
    .split(/[│┃|]/u)
    .map((c) => c.trim());

/**
 * A drawn table's rows (the header first), its wrapped cells put back
 * together: Claude Code draws a long cell on several lines, and when it
 * rules off every row, the lines between two rules are one row. Null when
 * the lines aren't a table.
 */
export function tableRows(lines: readonly string[]): string[][] | null {
  const groups: string[][][] = [[]];
  let rules = 0;
  for (const l of lines) {
    if (TABLE_RULE.test(l)) {
      rules++;
      if (groups[groups.length - 1].length) groups.push([]);
    } else if (TABLE_ROW.test(l)) groups[groups.length - 1].push(cellsOf(l));
  }
  const filled = groups.filter((g) => g.length);
  if (!filled.length || !filled.some((g) => g.some((r) => r.length > 1))) return null;
  // Ruled between every row (more groups than header + body): each group is a row. Else every line is one.
  const everyRow = filled.length > 2 || (filled.length === 2 && filled[1].length === 1);
  const merge = (g: string[][]) =>
    g[0].map((_c, i) =>
      g
        .map((r) => r[i] ?? '')
        .filter(Boolean)
        .join(' '),
    );
  const rows = everyRow ? filled.map(merge) : [merge(filled[0]), ...filled.slice(1).flat()];
  return rules || rows.length > 1 ? rows : null;
}

/** A table as HTML a paste keeps (`styleTables` adds the look). */
function tableHtml(rows: string[][]): string {
  const [head, ...body] = rows;
  const tr = (cells: string[], tag: 'th' | 'td') => `<tr>${cells.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join('')}</tr>`;
  return `<table><thead>${tr(head, 'th')}</thead><tbody>${body.map((r) => tr(r, 'td')).join('')}</tbody></table>`;
}

/**
 * What a copy from the terminal puts on the clipboard: the text put back
 * together (`cleanTerminalCopy`), and — when it holds a table, or bold or
 * italic text (`markedSelection`'s marks) — HTML too, so Teams, Outlook or
 * Word paste it formatted: a table as a table, bold as bold. Paragraphs are
 * set apart by a blank line (`<br>`s: a paste keeps them, where it dropped
 * `<p>` margins and ran every paragraph together).
 */
export function terminalCopy(text: string, cols: number, firstCol = 0): { text: string; html: string | null } {
  const marked = cleanMarked(text, cols, firstCol).split('\n');
  const lines = marked.map(plain);
  // Blank lines the selection ended with go.
  const clean = lines.join('\n').replace(/\s+$/u, '');
  const styled = marked.some((l) => /[\uE000-\uE003]/u.test(l));
  if (!styled && !lines.some((l) => TABLE_ROW.test(l))) return { text: clean, html: null };
  const isTableLine = (l: string) => TABLE_ROW.test(l) || TABLE_RULE.test(l);
  const blocks: Array<{ kind: 'p' | 'table'; html: string }> = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', html: para.join('<br>') });
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    if (isTableLine(lines[i])) {
      let j = i;
      while (j < lines.length && isTableLine(lines[j])) j++;
      const rows = tableRows(lines.slice(i, j));
      flush();
      blocks.push(
        rows ? { kind: 'table', html: tableHtml(rows) } : { kind: 'p', html: `<pre>${lines.slice(i, j).map(escapeHtml).join('\n')}</pre>` },
      );
      i = j;
    } else {
      if (lines[i].trim()) para.push(styledHtml(marked[i]));
      else flush();
      i++;
    }
  }
  flush();
  // A blank line between two paragraphs; a table is a block of its own.
  const html = blocks.map((b, k) => (k > 0 && b.kind === 'p' && blocks[k - 1].kind === 'p' ? '<br><br>' : '') + b.html).join('');
  return { text: clean, html: styleTables(`<div>${html}</div>`) };
}
