import { describe, expect, it } from 'vitest';
import { buildHunkHighlight, type FileContext } from '../../src/web/src/components/Diff/DiffHunk.js';
import { contextEnd, FILE_CONTEXT_MAX_LINES } from '../../src/web/src/hooks/use-file-context.js';
import { highlightBlock, resolveHighlightLang } from '../../src/web/src/utils/highlight.js';
import type { Hunk } from '../../src/web/src/api/client.js';

// A C# file with a raw string literal, as BackfillAuthorizationPaymentMethodType.cs has (reported: its diff coloured
// everything after the string's closing """ as a string, twice).
const file = [
  'public static class Backfill',
  '{',
  '    private const string AdyenUpdateSql = """',
  '        UPDATE authorizations a',
  '          AND payment_method_type IS NULL;',
  '        """;',
  '',
  '    public static async Task Run(IServiceProvider serviceProvider, int batchSize)',
  '    {',
  '        var context = serviceProvider.GetRequiredService<PayfacContext>();',
  '    }',
  '}',
];
const lang = resolveHighlightLang('Backfill.cs')!;

/** The hunk the diff showed: it starts inside the raw string (line 5), and changes the method's signature. */
const hunk: Hunk = {
  oldStart: 5,
  oldLines: 6,
  newStart: 5,
  newLines: 6,
  lines: [
    { kind: 'context', content: file[4], oldNum: 5, newNum: 5 },
    { kind: 'context', content: file[5], oldNum: 6, newNum: 6 },
    { kind: 'context', content: file[6], oldNum: 7, newNum: 7 },
    {
      kind: 'delete',
      content: '    public static async Task Run(IServiceProvider serviceProvider, long startId = 0)',
      oldNum: 8,
      newNum: null,
    },
    { kind: 'add', content: file[7], oldNum: null, newNum: 8 },
    { kind: 'context', content: file[8], oldNum: 9, newNum: 9 },
    { kind: 'context', content: file[9], oldNum: 10, newNum: 10 },
  ],
} as unknown as Hunk;

const ctx = (lines: string[]): FileContext => ({ lang, lines, html: highlightBlock(lines, lang) });
/** Whether a line's HTML is one string all through (the bug) — vs. keywords coloured as keywords. */
const allString = (html: string | undefined) => !!html && /^<span class="hljs-string">/.test(html) && !html.includes('hljs-keyword');

describe("a hunk that starts inside a string is coloured as the file is (the file's text above it)", () => {
  it('without the context: the closing """ opens a string, and the code after it reads as one (the bug, kept as the fallback)', () => {
    const alone = buildHunkHighlight(hunk, lang)!;
    expect(allString(alone.new.get(8))).toBe(true);
  });

  it('with it: both sides come out right — keywords on the new method line, the removed line too', () => {
    const h = buildHunkHighlight(hunk, lang, ctx(file))!;
    expect(h.new.get(8)).toContain('hljs-keyword');
    expect(allString(h.new.get(8))).toBe(false);
    expect(h.new.get(10)).toContain('hljs-keyword'); // var
    expect(h.old.get(8)).toContain('hljs-keyword');
    expect(allString(h.old.get(8))).toBe(false);
  });

  it("a file that doesn't match the diff (changed since it was read) isn't used: the hunk alone, as before", () => {
    const changed = file.map((l, i) => (i === 7 ? l + ' // edited since' : l));
    expect(buildHunkHighlight(hunk, lang, ctx(changed))).toEqual(buildHunkHighlight(hunk, lang));
    expect(buildHunkHighlight(hunk, lang, { ...ctx(file), lang: 'typescript' })).toEqual(buildHunkHighlight(hunk, lang));
  });

  it('contextEnd: how far the hunks reach on the newer side; nothing for a deleted or binary file', () => {
    expect(contextEnd({ hunks: [hunk, { ...hunk, newStart: 40, newLines: 10 }], status: 'modified', isBinary: false })).toBe(49);
    expect(contextEnd({ hunks: [hunk], status: 'deleted', isBinary: false })).toBe(0);
    expect(contextEnd({ hunks: [hunk], status: 'modified', isBinary: true })).toBe(0);
    expect(FILE_CONTEXT_MAX_LINES).toBeGreaterThanOrEqual(1000);
  });
});
