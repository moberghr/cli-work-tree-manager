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
 * @param cols the terminal's width in columns.
 * @param firstCol the column the selection started at: its first line's text began there, not at 0.
 */
export function cleanTerminalCopy(text: string, cols: number, firstCol = 0): string {
  // Markers become spaces, so every line keeps its columns for the width test.
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/u, '').replace(MARKER, (_m, lead: string, _mk: string, sp: string) => lead + ' ' + sp));
  const col0 = (i: number) => (i === 0 ? firstCol : 0);
  const out: string[] = [];
  // Each output line keeps where it started and the indent its continuation lines have.
  let cur: { text: string; cont: number; end: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const body = l.trimStart();
    const indent = col0(i) + indentOf(l);
    const end = col0(i) + l.length; // the column its last character ended at
    if (cur && body && cur.end + 1 + (body.split(/\s/u)[0]?.length ?? 0) > cols - 2 && !STARTS_ITS_OWN.test(body) && indent === cur.cont) {
      cur.text += ' ' + body;
      cur.end = end;
      continue;
    }
    if (cur) out.push(cur.text);
    if (!body) {
      cur = null;
      out.push('');
      continue;
    }
    const item = LIST_ITEM.exec(body);
    cur = { text: (i === 0 ? '' : ' '.repeat(indentOf(l))) + body, cont: indent + (item ? item[0].length : 0), end };
    // A line that is a table or box row never takes the next one in.
    if (/[│┃]/u.test(body)) {
      out.push(cur.text);
      cur = null;
    }
  }
  if (cur) out.push(cur.text);
  // The indentation every line shares (the first line's selection may have started past it).
  const rest = out.slice(1).filter((l) => l.trim());
  const shared = rest.length ? Math.min(...rest.map(indentOf)) : 0;
  return out.map((l, i) => (i === 0 ? l.trimStart() : l.slice(Math.min(shared, indentOf(l))))).join('\n');
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
 * together (`cleanTerminalCopy`), and — when it holds a table — HTML too, so
 * Teams, Outlook or Word paste the table as a table. Plain text around it
 * goes in as paragraphs.
 */
export function terminalCopy(text: string, cols: number, firstCol = 0): { text: string; html: string | null } {
  const clean = cleanTerminalCopy(text, cols, firstCol);
  const lines = clean.split('\n');
  const isTableLine = (l: string) => TABLE_ROW.test(l) || TABLE_RULE.test(l);
  if (!lines.some((l) => TABLE_ROW.test(l))) return { text: clean, html: null };
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(escapeHtml).join('<br>')}</p>`);
    para = [];
  };
  let tables = 0;
  for (let i = 0; i < lines.length;) {
    if (isTableLine(lines[i])) {
      let j = i;
      while (j < lines.length && isTableLine(lines[j])) j++;
      const rows = tableRows(lines.slice(i, j));
      flush();
      if (rows) {
        out.push(tableHtml(rows));
        tables++;
      } else out.push(`<pre>${lines.slice(i, j).map(escapeHtml).join('\n')}</pre>`);
      i = j;
    } else {
      if (lines[i].trim()) para.push(lines[i]);
      else flush();
      i++;
    }
  }
  flush();
  return { text: clean, html: tables ? styleTables(out.join('')) : null };
}
