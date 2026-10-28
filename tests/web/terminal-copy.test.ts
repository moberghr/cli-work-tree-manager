// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanTerminalCopy, tableRows, terminalCopy } from '../../src/web/src/state/terminal-copy.js';

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
    expect(html).toContain('<p>Here is the comparison:</p>');
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
