// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  cleanTerminalCopy,
  markedSelection,
  plain,
  selectionText,
  tableRows,
  terminalCopy,
} from '../../src/web/src/state/terminal-copy.js';

/** A row as the terminal draws it: `text`, padded with spaces to the screen's width (Claude Code pads some). */
const row = (text: string, pad = 0) => text + ' '.repeat(pad);

describe('cleanTerminalCopy — what you copy from a terminal, put back together', () => {
  // A copy reported as garbled: Claude's reply on a 236-column terminal, selected from just after its "● ".
  const COLS = 236;
  const para1 =
    "Why copied text comes out messy: copying takes exactly what is drawn on the screen. Claude Code does its own line wrapping when it draws, so the terminal can't tell a wrapped paragraph from separate lines. A copy of a reply usually";
  const item1 =
    "Clean up on copy. On every copy (Ctrl+C with a selection, a right-click Copy, the browser's copy), drop trailing spaces and Claude's indent and markers, and rejoin lines that were only wrapped by screen width. This is cheap and";
  const copied = [
    "I haven't changed anything yet; I'd like to see one example first. Here is what I found in the code.",
    '',
    row('  ' + para1, 3),
    '  gets:',
    '  - a hard line break at every screen-width wrap, so paragraphs are chopped up;',
    row('  - the 2-space indent Claude Code puts on its replies, on every line;', 166),
    "  - trailing spaces padding each line out to the screen's width;",
    '',
    '  What we could do:',
    row('  1. ' + item1, 4),
    "     fixes most cases. It's a guess, though, so code blocks stay exactly as drawn.",
    '  2. A short item.',
  ].join('\n');

  it('rejoins the paragraphs Claude Code wrapped, keeps the lines it meant, and drops the indent and padding', () => {
    expect(cleanTerminalCopy(copied, COLS, 2)).toBe(
      [
        "I haven't changed anything yet; I'd like to see one example first. Here is what I found in the code.",
        '',
        para1 + ' gets:',
        '- a hard line break at every screen-width wrap, so paragraphs are chopped up;',
        '- the 2-space indent Claude Code puts on its replies, on every line;',
        "- trailing spaces padding each line out to the screen's width;",
        '',
        'What we could do:',
        '1. ' + item1 + " fixes most cases. It's a guess, though, so code blocks stay exactly as drawn.",
        '2. A short item.',
      ].join('\n'),
    );
  });

  it('a line whose next word would have fit was broken on purpose: short lines and code stay as they are', () => {
    const code = ['  const a = 1;', '  if (a) {', '    run(a);', '  }'].join('\n');
    expect(cleanTerminalCopy(code, 80)).toBe(['const a = 1;', 'if (a) {', '  run(a);', '}'].join('\n'));
  });

  it("a full line followed by a list item, a heading or a table row isn't joined to it", () => {
    const full = 'x'.repeat(76);
    for (const next of ['- item', '1. item', '## Heading', '│ a │ b │']) {
      expect(cleanTerminalCopy(`  ${full}\n  ${next}`, 80)).toBe(`${full}\n${next}`);
    }
  });

  it("Claude Code's gutter markers go", () => {
    expect(cleanTerminalCopy('● Done: the build passes.\n  ⎿  Read 3 files', 80)).toBe('Done: the build passes.\nRead 3 files');
  });

  it('table rows are never joined, even full ones', () => {
    const r = '│ ' + 'y'.repeat(74) + ' │';
    expect(cleanTerminalCopy(`${r}\n${r}`, 80)).toBe(`${r}\n${r}`);
  });
});

describe('a table copied from the terminal pastes as a table (Teams, Outlook, Word)', () => {
  it("Claude Code's drawn table becomes an HTML table beside the text; the text around it, paragraphs", () => {
    const drawn = [
      'Here is the comparison:',
      '',
      '┌──────────┬───────────┐',
      '│ Option   │ Cost      │',
      '├──────────┼───────────┤',
      '│ Clean up │ cheap     │',
      '│ Copy     │ a route   │',
      '└──────────┴───────────┘',
    ].join('\n');
    const { text, html } = terminalCopy(drawn, 120);
    expect(text).toBe(drawn);
    expect(html).toMatch(/^<div>Here is the comparison:<table /);
    const doc = new DOMParser().parseFromString(html!, 'text/html');
    expect([...doc.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Option', 'Cost']);
    expect([...doc.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))).toEqual([
      ['Clean up', 'cheap'],
      ['Copy', 'a route'],
    ]);
    // The look inline, since a paste drops classes.
    expect(doc.querySelector('table')!.getAttribute('style')).toContain('border-collapse');
    expect(doc.querySelector('td')!.getAttribute('style')).toContain('border:1px solid');
  });

  it('a cell drawn on two lines is one cell again when every row is ruled off', () => {
    const rows = tableRows([
      '┌────────┬──────────────┐',
      '│ Step   │ What         │',
      '├────────┼──────────────┤',
      '│ 1      │ Fetch the    │',
      '│        │ branch       │',
      '├────────┼──────────────┤',
      '│ 2      │ Rebase       │',
      '└────────┴──────────────┘',
    ]);
    expect(rows).toEqual([
      ['Step', 'What'],
      ['1', 'Fetch the branch'],
      ['2', 'Rebase'],
    ]);
  });

  it('a Markdown table printed as is is a table too; text with no table gets no HTML', () => {
    expect(tableRows(['| a | b |', '|---|:--|', '| 1 | 2 |'])).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(terminalCopy('just a sentence', 80).html).toBeNull();
    expect(terminalCopy('a | b', 80).html).toBeNull();
  });

  it('cell text is escaped', () => {
    const { html } = terminalCopy(['│ <b>x</b> │ a & b │', '├───┼───┤', '│ 1 │ 2 │'].join('\n'), 80);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &amp; b');
  });
});

/** A terminal buffer as xterm has it: rows of cells, `**x**` marking bold cells and `_x_` italic ones. */
function buffer(rows: string[], wrapped: number[] = []) {
  const parsed = rows.map((r) => {
    const cells: Array<{ ch: string; b: boolean; i: boolean }> = [];
    let b = false;
    let it = false;
    for (let k = 0; k < r.length; k++) {
      if (r.startsWith('**', k)) {
        b = !b;
        k++;
        continue;
      }
      if (r[k] === '_') {
        it = !it;
        continue;
      }
      cells.push({ ch: r[k], b, i: it });
    }
    return cells;
  });
  return {
    getLine: (y: number) =>
      parsed[y] && {
        isWrapped: wrapped.includes(y),
        length: parsed[y].length,
        getCell: (x: number) =>
          parsed[y][x] && {
            getChars: () => parsed[y][x].ch,
            getWidth: () => 1,
            isBold: () => (parsed[y][x].b ? 1 : 0),
            isItalic: () => (parsed[y][x].i ? 1 : 0),
          },
      },
  };
}
const whole = (rows: string[]) => ({ start: { x: 0, y: 0 }, end: { x: 80, y: rows.length - 1 } });

describe('bold and italic from the terminal, and a blank line between paragraphs (pasted into Teams)', () => {
  it('markedSelection reads the cells: plain, it is exactly the selected text', () => {
    const rows = ['**1. A long paragraph.** Make it _wrap_.   ', '', 'Then **paste** it.'];
    const m = markedSelection(buffer(rows), whole(rows));
    expect(plain(m)).toBe('1. A long paragraph. Make it wrap.\n\nThen paste it.');
    expect(m).not.toBe(plain(m));
  });

  it('bold and italic become <b> and <i>; a run broken only by a space is one; the plain text has none of it', () => {
    const rows = ['**1. A long paragraph.** Make it _wrap_ now.', '', '**Two** **words**'];
    const { text, html } = terminalCopy(markedSelection(buffer(rows), whole(rows)), 80);
    expect(text).toBe('1. A long paragraph. Make it wrap now.\n\nTwo words');
    expect(html).toBe('<div><b>1. A long paragraph.</b> Make it <i>wrap</i> now.<br><br><b>Two words</b></div>');
  });

  it('bold ending while italic goes on: the tags never cross', () => {
    const rows = ['**bold _both** italic_ plain'];
    const { html } = terminalCopy(markedSelection(buffer(rows), whole(rows)), 80);
    expect(html).toBe('<div><b>bold <i>both</i></b> <i>italic</i> plain</div>');
  });

  it('a style survives the line being joined back, and each line stays balanced', () => {
    const rows = ['  **This bold sentence was wrapped by Claude Code at the edge of the screen right**', '  **before here.**'];
    const { text, html } = terminalCopy(markedSelection(buffer(rows), whole(rows)), 80);
    expect(text).toBe('This bold sentence was wrapped by Claude Code at the edge of the screen right before here.');
    expect(html).toBe('<div><b>This bold sentence was wrapped by Claude Code at the edge of the screen right before here.</b></div>');
  });

  it('a row the terminal wrapped itself runs on with no line break, its space at the edge kept', () => {
    const rows = ['one two ', 'three'];
    expect(plain(markedSelection(buffer(rows, [1]), whole(rows)))).toBe('one two three');
  });

  it('only the selected columns: from the start column on the first row, up to (not including) the end one on the last', () => {
    const rows = ['● **Done**: all good', 'more text here'];
    expect(plain(markedSelection(buffer(rows), { start: { x: 2, y: 0 }, end: { x: 4, y: 1 } }))).toBe('Done: all good\nmore');
  });

  it('plain text with no table and no style needs no HTML', () => {
    expect(terminalCopy('First paragraph.\n\nSecond.', 80).html).toBeNull();
  });
});

describe('selectionText — the styles, never at the cost of the text', () => {
  const term = (rows: string[], text: string, range = whole(rows)) => ({
    getSelection: () => text,
    getSelectionPosition: () => range,
    buffer: { active: buffer(rows) },
  });
  it('the marked text when it reads the same as the selection', () => {
    const rows = ['**Done**: all good'];
    expect(selectionText(term(rows, 'Done: all good'))).toBe(markedSelection(buffer(rows), whole(rows)));
  });
  it('several lines too: xterm ends them with \\r\\n on Windows (every multi-line copy lost its bold to that, in a real browser)', () => {
    const rows = ['**Done**: all good   ', 'next line'];
    const styled = selectionText(term(rows, 'Done: all good\r\nnext line'));
    expect(styled).toBe(markedSelection(buffer(rows), whole(rows)));
    expect(terminalCopy(styled, 80).html).toBe('<div><b>Done</b>: all good<br>next line</div>');
  });
  it("the plain selection when they don't (a column selection, a buffer that moved), or there's no range", () => {
    expect(selectionText(term(['**Done**: all good'], 'something else'))).toBe('something else');
    expect(selectionText({ ...term(['x'], 'x'), getSelectionPosition: () => undefined })).toBe('x');
  });
});
