// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Hunk } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A C# file whose raw string spans the gap between two hunks: the lines revealed there start inside it.
const file = [
  'public static class Backfill', //                     1
  '{', //                                                2
  '    private const string Sql = """', //               3
  '        UPDATE authorizations a', //                  4
  '          AND payment_method_type IS NULL;', //       5
  '        """;', //                                     6
  '    public static async Task Run(int batchSize)', //  7
  '    {', //                                            8
  '        var context = 1;', //                         9
  '    }', //                                            10
  '}', //                                                11
];
const h = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchFileLines: async (_hash: string | undefined, _repo: string, _path: string, start: number, end: number) => ({
    lines: h.lines.slice(start - 1, end),
    start,
    totalLines: h.lines.length,
    eof: end >= h.lines.length,
  }),
}));

const { GapRegion } = await import('../../src/web/src/components/Diff/GapRegion.js');
const { ExpandProvider } = await import('../../src/web/src/state/ExpandProvider.js');
const { computeGaps } = await import('../../src/web/src/utils/expand.js');
const { highlightBlock, resolveHighlightLang } = await import('../../src/web/src/utils/highlight.js');

const hunk = (start: number, n: number): Hunk =>
  ({
    oldStart: start,
    oldLines: n,
    newStart: start,
    newLines: n,
    lines: file.slice(start - 1, start - 1 + n).map((content, i) => ({ kind: 'context', content, oldNum: start + i, newNum: start + i })),
  }) as unknown as Hunk;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.lines = file;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function reveal(withContext: boolean): Promise<string> {
  const lang = resolveHighlightLang('Backfill.cs')!;
  const gap = computeGaps([hunk(1, 4), hunk(10, 2)]).find((g) => g.bottom !== null && g.top !== null)!;
  const context = withContext ? { lang, lines: file, html: highlightBlock(file, lang) } : null;
  await act(async () =>
    root.render(
      createElement(ExpandProvider, {
        scopeHash: 'h',
        children: createElement(
          'table',
          null,
          createElement('tbody', null, createElement(GapRegion, { repo: 'api', file: 'Backfill.cs', gap, lang, context })),
        ),
      }),
    ),
  );
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Expand lines below the section above"]')!.click();
    await new Promise((r) => setTimeout(r, 0));
  });
  // Line 7, revealed: `public static async Task Run(…)`.
  const cell = [...container.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('public static async Task Run'));
  return cell?.innerHTML ?? '';
}

describe('lines revealed between hunks are coloured as the file is', () => {
  it('without the whole-file colouring the revealed run starts inside the raw string: its closing """ opens one (the bug)', async () => {
    const html = await reveal(false);
    expect(html).not.toContain('hljs-keyword">public');
  });

  it('with it, the method line after the string has its keywords', async () => {
    const html = await reveal(true);
    expect(html).toContain('<span class="hljs-keyword">public</span>');
  });
});
