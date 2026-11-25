import { describe, expect, it, vi } from 'vitest';
import type { TerminalPathWire } from '../../src/core/api-types.js';
import {
  createPathCache,
  FAILED_PAUSE_MS,
  logicalStart,
  MAX_PATH_CHARS,
  openFailure,
  pathMenuItems,
  pickLinks,
  platformOf,
  readRow,
  rowLinkCandidates,
  toXtermRange,
  type LinkCandidate,
  type LinkRow,
} from '../../src/web/src/state/terminal-links.js';

/** A screen as getRow reads it: undefined above the first row and below the last. */
const screen = (rows: LinkRow[]) => (y: number) => rows[y];

const file = (raw: string, path = `/real/${raw}`): TerminalPathWire => ({ raw, path, kind: 'file', opens: 'editor' });
const missing = (raw: string): TerminalPathWire => ({ raw, path: null, kind: 'missing', opens: null });
const results = (...rs: TerminalPathWire[]) => new Map(rs.map((r) => [r.raw, r]));

describe('logicalStart — the first row of the line a row belongs to', () => {
  it('walks up over soft wraps', () => {
    const get = screen([{ text: 'before' }, { text: 'aaa' }, { text: 'bbb', wrapped: true }, { text: 'ccc', wrapped: true }]);
    expect(logicalStart(get, 3, 80)).toBe(1);
    expect(logicalStart(get, 1, 80)).toBe(1);
    expect(logicalStart(get, 0, 80)).toBe(0);
  });

  it("walks up over Claude Code's own breaks: a (nearly) full row, then an indented row with text", () => {
    const full = 'x'.repeat(9); // cols - 1
    expect(logicalStart(screen([{ text: full }, { text: '  more' }]), 1, 10)).toBe(0);
    expect(logicalStart(screen([{ text: 'short' }, { text: '  more' }]), 1, 10)).toBe(1);
    expect(logicalStart(screen([{ text: 'x'.repeat(10) }, { text: '   ' }]), 1, 10)).toBe(1);
  });

  it('stops after 8 rows', () => {
    const rows: LinkRow[] = [{ text: 'a' }, ...Array.from({ length: 11 }, () => ({ text: 'b', wrapped: true }))];
    expect(logicalStart(screen(rows), 11, 80)).toBe(4);
  });
});

describe('rowLinkCandidates — the paths that touch a row', () => {
  it('a path on one row: its columns, 0-based, end inclusive', () => {
    const get = screen([{ text: 'see src/web/x.tsx:12 now' }]);
    expect(rowLinkCandidates(get, 0, 80)).toEqual([
      { raw: 'src/web/x.tsx:12', range: { start: { x: 4, y: 0 }, end: { x: 19, y: 0 } }, joined: false },
    ]);
    expect(rowLinkCandidates(get, 1, 80)).toEqual([]);
  });

  it('a path over two rows (soft wrap): the same link hovered on either row, plus each row’s own piece', () => {
    // 20 columns: '/tmp/aaaa/bbbb' fills the first row, xterm wraps the rest.
    const get = screen([{ text: 'look: /tmp/aaaa/bbbb' }, { text: 'cc/file.ts done', wrapped: true }]);
    const joined: LinkCandidate = {
      raw: '/tmp/aaaa/bbbbcc/file.ts',
      range: { start: { x: 6, y: 0 }, end: { x: 9, y: 1 } },
      joined: true,
    };
    expect(rowLinkCandidates(get, 0, 20)).toEqual([
      joined,
      { raw: '/tmp/aaaa/bbbb', range: { start: { x: 6, y: 0 }, end: { x: 19, y: 0 } }, joined: false },
    ]);
    expect(rowLinkCandidates(get, 1, 20)).toEqual([
      joined,
      { raw: 'cc/file.ts', range: { start: { x: 0, y: 1 }, end: { x: 9, y: 1 } }, joined: false },
    ]);
  });

  describe('the real example: a scratchpad address Claude Code broke over two rows', () => {
    const row1 =
      'mockup to show it (reopened): session-rail-designs.html (file:///private/tmp/claude-502/-Users-me-Dev-worktrees-work-tree-session-start-u';
    const row2 = '  i/7584/scratchpad/session-rail-designs.html).';
    const cols = row1.length; // filled to the last column
    const get = screen([{ text: row1 }, { text: row2 }]);
    const address =
      'file:///private/tmp/claude-502/-Users-me-Dev-worktrees-work-tree-session-start-ui/7584/scratchpad/session-rail-designs.html';
    const joined: LinkCandidate = {
      raw: address,
      range: { start: { x: row1.indexOf('file://'), y: 0 }, end: { x: row2.indexOf(').') - 1, y: 1 } },
      joined: true,
    };

    it('joins the full address, the indent of the second row dropped, hovered on either row', () => {
      expect(rowLinkCandidates(get, 0, cols)).toContainEqual(joined);
      expect(rowLinkCandidates(get, 1, cols)).toContainEqual(joined);
    });

    it('keeps the unjoined pieces to fall back on, and lists a path away from the break once', () => {
      const top = rowLinkCandidates(get, 0, cols);
      expect(top.filter((c) => !c.joined).map((c) => c.raw)).toEqual([
        'session-rail-designs.html',
        'file:///private/tmp/claude-502/-Users-me-Dev-worktrees-work-tree-session-start-u',
      ]);
      const bottom = rowLinkCandidates(get, 1, cols);
      expect(bottom.filter((c) => !c.joined)).toEqual([
        {
          raw: 'i/7584/scratchpad/session-rail-designs.html',
          range: { start: { x: 2, y: 1 }, end: { x: 2 + 'i/7584/scratchpad/session-rail-designs.html'.length - 1, y: 1 } },
          joined: false,
        },
      ]);
    });
  });

  it('a row read from the buffer: a wide character takes two cells, and the range is in cells', () => {
    // '✅ ab.ts': the emoji's right half is a cell of width 0.
    const cells = [
      { chars: '✅', width: 2 },
      { chars: '', width: 0 },
      ...' ab.ts  '.split('').map((c) => ({ chars: c === ' ' ? '' : c, width: 1 })),
    ];
    const line = {
      isWrapped: false,
      length: cells.length,
      getCell: (x: number) => (cells[x] ? { getChars: () => cells[x].chars, getWidth: () => cells[x].width } : undefined),
    };
    const row = readRow(line);
    expect(row?.text).toBe('✅ ab.ts');
    expect(rowLinkCandidates(screen(row ? [row] : []), 0, 80).map((c) => c.range)).toEqual([
      { start: { x: 3, y: 0 }, end: { x: 7, y: 0 } },
    ]);
    expect(readRow(undefined)).toBeUndefined();
  });

  it('xterm counts from 1', () => {
    expect(toXtermRange({ start: { x: 0, y: 4 }, end: { x: 9, y: 5 } })).toEqual({ start: { x: 1, y: 5 }, end: { x: 10, y: 6 } });
  });
});

describe('pickLinks — only paths that exist are links', () => {
  const joined: LinkCandidate = { raw: '/a/bc/d.ts', range: { start: { x: 6, y: 0 }, end: { x: 3, y: 1 } }, joined: true };
  const piece: LinkCandidate = { raw: 'c/d.ts', range: { start: { x: 0, y: 1 }, end: { x: 5, y: 1 } }, joined: false };
  const other: LinkCandidate = { raw: 'x/y.ts', range: { start: { x: 10, y: 1 }, end: { x: 15, y: 1 } }, joined: false };

  it('the joined path when it exists, not the piece it covers', () => {
    const picked = pickLinks([joined, piece, other], results(file(joined.raw), file(piece.raw), file(other.raw)));
    expect(picked.map((c) => c.raw)).toEqual([joined.raw, other.raw]);
    expect(picked[0].result.path).toBe('/real//a/bc/d.ts');
  });

  it('the piece when the joined path does not exist', () => {
    expect(pickLinks([joined, piece], results(missing(joined.raw), file(piece.raw))).map((c) => c.raw)).toEqual([piece.raw]);
  });

  it('nothing when none exists, or the server was not asked', () => {
    expect(pickLinks([joined, piece], results(missing(joined.raw), missing(piece.raw)))).toEqual([]);
    expect(pickLinks([joined, piece], new Map())).toEqual([]);
  });

  it('an ambiguous bare name is a link: it opens the code search', () => {
    const name: LinkCandidate = { raw: 'SessionRail.tsx', range: { start: { x: 0, y: 0 }, end: { x: 14, y: 0 } }, joined: false };
    const amb: TerminalPathWire = { raw: name.raw, path: null, kind: 'ambiguous', opens: 'search' };
    expect(pickLinks([name], results(amb))).toEqual([{ ...name, result: amb }]);
  });
});

describe('createPathCache — which paths exist, asked once in a while', () => {
  const found = (paths: string[]) => paths.map((p) => file(p));

  it('asks once for many raws (each once), then answers from the cache', async () => {
    const resolve = vi.fn(async (paths: string[]) => found(paths));
    const cache = createPathCache(resolve);
    const first = await cache.lookup(['a.ts', 'b.ts', 'a.ts', 'c.ts']);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(['a.ts', 'b.ts', 'c.ts']);
    expect([...first.keys()]).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const again = await cache.lookup(['b.ts', 'c.ts']);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(again.get('b.ts')?.kind).toBe('file');
    await cache.lookup(['b.ts', 'd.ts']);
    expect(resolve).toHaveBeenLastCalledWith(['d.ts']);
  });

  it('asks again once an answer is older than its life', async () => {
    let t = 1000;
    const resolve = vi.fn(async (paths: string[]) => found(paths));
    const cache = createPathCache(resolve, () => t, 10_000);
    await cache.lookup(['a.ts']);
    t += 9_999;
    await cache.lookup(['a.ts']);
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 2;
    await cache.lookup(['a.ts']);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('lookups at the same time share one request', async () => {
    let answer: (r: TerminalPathWire[]) => void = () => {};
    const resolve = vi.fn((_paths: string[]) => new Promise<TerminalPathWire[]>((r) => (answer = r)));
    const cache = createPathCache(resolve);
    const one = cache.lookup(['a.ts', 'b.ts']);
    const two = cache.lookup(['b.ts', 'a.ts']);
    expect(resolve).toHaveBeenCalledTimes(1);
    answer([file('a.ts'), missing('b.ts')]);
    const [r1, r2] = await Promise.all([one, two]);
    expect(r1.get('a.ts')?.kind).toBe('file');
    expect(r2.get('b.ts')?.kind).toBe('missing');
  });

  it('a failed request answers "missing", is not remembered, and nothing is asked for a moment after it', async () => {
    let t = 1000;
    const resolve = vi.fn(async (_paths: string[]): Promise<TerminalPathWire[]> => {
      throw new Error('404 unknown session');
    });
    const cache = createPathCache(resolve, () => t);
    const r = await cache.lookup(['a.ts', 'b.ts']);
    expect([...r.values()].map((x) => x.kind)).toEqual(['missing', 'missing']);
    resolve.mockImplementation(async (paths: string[]) => found(paths));
    // Still inside the pause: a hover asks nothing.
    t += FAILED_PAUSE_MS - 1;
    expect((await cache.lookup(['a.ts'])).get('a.ts')?.kind).toBe('missing');
    expect(resolve).toHaveBeenCalledTimes(1);
    t += 1;
    expect((await cache.lookup(['a.ts'])).get('a.ts')?.kind).toBe('file');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('a path longer than the server takes is no candidate', () => {
    const long = '/' + 'a'.repeat(MAX_PATH_CHARS) + '/x.ts';
    const rows: LinkRow[] = [{ text: `see ${long} and /tmp/ok.ts` }];
    const raws = rowLinkCandidates((y) => rows[y], 0, long.length + 40).map((c) => c.raw);
    expect(raws).toEqual(['/tmp/ok.ts']);
  });

  it('asks at most 50 at a time', async () => {
    const resolve = vi.fn(async (paths: string[]) => found(paths));
    const cache = createPathCache(resolve);
    const raws = Array.from({ length: 120 }, (_, i) => `f${i}.ts`);
    const r = await cache.lookup(raws);
    expect(resolve.mock.calls.map(([paths]) => paths.length)).toEqual([50, 50, 20]);
    expect(r.size).toBe(120);
    expect(r.get('f119.ts')?.path).toBe('/real/f119.ts');
  });

  it('forgets everything on clear(), an answer still on its way included', async () => {
    let answer: (r: TerminalPathWire[]) => void = () => {};
    const resolve = vi.fn((_paths: string[]) => new Promise<TerminalPathWire[]>((r) => (answer = r)));
    const cache = createPathCache(resolve);
    const pending = cache.lookup(['a.ts']);
    cache.clear();
    answer([file('a.ts')]);
    await pending;
    void cache.lookup(['a.ts']);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe('pathMenuItems — the right-click menu of a path', () => {
  it('a file: open three ways, copy its path; the reveal named as the system names it', () => {
    expect(pathMenuItems(file('x.ts'), 'mac')).toEqual([
      { id: 'open', label: 'Open' },
      { id: 'editor', label: 'Open in editor' },
      { id: 'reveal', label: 'Reveal in Finder' },
      { id: 'copy', label: 'Copy path' },
    ]);
    expect(pathMenuItems(file('x.ts'), 'windows').find((i) => i.id === 'reveal')?.label).toBe('Show in Explorer');
    expect(pathMenuItems(file('x.ts'), 'other').find((i) => i.id === 'reveal')?.label).toBe('Show in file manager');
  });

  it('a folder is only revealed, never opened', () => {
    const dir: TerminalPathWire = { raw: 'src/web', path: '/w/src/web', kind: 'dir', opens: 'reveal' };
    expect(pathMenuItems(dir, 'mac').map((i) => i.id)).toEqual(['reveal', 'copy']);
  });

  it('an ambiguous bare name: search the code for it, without its line', () => {
    const amb: TerminalPathWire = { raw: 'SessionRail.tsx:202', path: null, kind: 'ambiguous', opens: 'search', line: 202 };
    expect(pathMenuItems(amb, 'mac')).toEqual([{ id: 'search', label: 'Search the code for “SessionRail.tsx”' }]);
    expect(pathMenuItems(missing('x.ts'), 'mac')).toEqual([]);
  });

  it('platformOf reads navigator.platform or the user agent', () => {
    expect(platformOf('MacIntel')).toBe('mac');
    expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac');
    expect(platformOf('Win32')).toBe('windows');
    expect(platformOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows');
    expect(platformOf('Darwin')).toBe('other');
    expect(platformOf('Linux x86_64')).toBe('other');
  });

  it('a failed open, in words', () => {
    expect(openFailure('x.ts', 'missing')).toBe('Couldn’t open x.ts: there is no such file here.');
    expect(openFailure('x.ts', 'ambiguous')).toBe('Couldn’t open x.ts: several files have that name.');
    expect(openFailure('x.ts', 'spawn code ENOENT')).toBe('Couldn’t open x.ts: spawn code ENOENT');
  });
});
