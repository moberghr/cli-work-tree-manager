// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CodeFileWire, CodeFilesWire, CodeSearchWire } from '../../src/core/api-types.js';
import { matchRange, searchGroups, SHOWN } from '../../src/web/src/state/code-search-view.js';
import { codeEntries, filterEntries } from '../../src/web/src/state/code-tree.js';
import { demoCodeSearch } from '../../src/server/demo/demo-code.js';
import { parseGitDiff } from '../../src/core/diff/diff-parse.js';
import type { SessionSummary } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LISTING: CodeFilesWire = {
  group: false,
  rootFiles: [],
  repos: [{ name: 'api', files: ['src/Keys.cs', 'src/use.ts', 'README.md'], changed: [], truncated: false }],
};
const WIRE: CodeSearchWire = {
  query: 'keys',
  symbols: [{ name: 'AccountingKeys', kind: 'class', repo: 'api', path: 'src/Keys.cs', line: 2, text: 'public class AccountingKeys' }],
  text: [
    { repo: 'api', path: 'src/Keys.cs', line: 2, text: 'public class AccountingKeys' },
    { repo: 'api', path: 'src/use.ts', line: 1, text: "  return 'keys';" },
  ],
  truncated: false,
};

describe('what the search box lists', () => {
  it('types and members, then files, then text — each only when it has something', () => {
    const files = filterEntries(codeEntries(LISTING), 'keys');
    const groups = searchGroups(WIRE, files, false);
    expect(groups.map((g) => g.title)).toEqual(['Types & members', 'Files', 'Text · 2']);
    expect(groups[0].rows[0]).toMatchObject({
      kind: 'symbol',
      label: 'AccountingKeys',
      repo: 'api',
      path: 'src/Keys.cs',
      line: 2,
      symbolKind: 'class',
    });
    expect(groups[1].rows.map((r) => r.sub)).toEqual(['src/Keys.cs']);
    expect(groups[2].rows[1]).toMatchObject({ label: "return 'keys';", sub: 'src/use.ts:1', line: 1 });
    expect(searchGroups(null, [], false)).toEqual([]);
  });

  it("a group's places name their repo; more text than shown says so", () => {
    const many: CodeSearchWire = {
      ...WIRE,
      symbols: [],
      text: Array.from({ length: SHOWN.text + 5 }, (_, i) => ({ ...WIRE.text[0], line: i + 1 })),
    };
    const [text] = searchGroups(many, [], true);
    expect(text.title).toBe(`Text · the first ${SHOWN.text}`);
    expect(text.rows[0].sub).toBe('api/src/Keys.cs:1');
  });

  it('marks what was searched for, with the same case rule as the search', () => {
    expect(matchRange('public class AccountingKeys', 'keys')).toEqual([23, 27]);
    expect(matchRange('public class AccountingKeys', 'KEYS')).toBeNull(); // a capital: that case
  });

  it('the demo searches its own files the same way', () => {
    const diff = parseGitDiff(
      [
        'diff --git a/src/cart.ts b/src/cart.ts',
        '--- a/src/cart.ts',
        '+++ b/src/cart.ts',
        '@@ -0,0 +1,2 @@',
        '+export function addToCart() {',
        '+}',
        '',
      ].join('\n'),
    );
    const w = demoCodeSearch([{ name: 'web', changed: diff }], false, 'atc');
    expect(w.symbols.map((s) => s.name)).toEqual(['addToCart']);
    expect(demoCodeSearch([{ name: 'web', changed: diff }], false, 'addtocart').text.map((t) => t.path)).toEqual(['src/cart.ts']);
    expect(demoCodeSearch([{ name: 'web', changed: diff }], false, 'a').symbols).toEqual([]);
  });
});

// ---- the components --------------------------------------------------------

const h = vi.hoisted(() => ({ search: vi.fn(), files: vi.fn() }));
vi.mock('../../src/web/src/api/client.js', async (orig) => ({
  ...(await orig<typeof import('../../src/web/src/api/client.js')>()),
  fetchCodeFiles: (...a: unknown[]) => h.files(...a),
  fetchCodeSearch: (...a: unknown[]) => h.search(...a),
  fetchCodeFile: async (_id: string, repo: string, path: string): Promise<CodeFileWire> => ({
    repo,
    path,
    size: 10,
    text: Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n'),
  }),
}));
vi.mock('../../src/web/src/api/events.js', () => ({ useSse: () => {} }));
const { CodeSearch } = await import('../../src/web/src/components/Code/CodeSearch.js');
const { CodeView } = await import('../../src/web/src/components/Code/CodeView.js');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  h.files.mockReset().mockResolvedValue(LISTING);
  h.search.mockReset().mockResolvedValue(WIRE);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('the Ctrl+T box', () => {
  it('asks once typing pauses, lists the groups, and Enter opens the first at its line', async () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(createElement(CodeSearch, { sessionId: 's1', onPick, onClose })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    const input = container.querySelector<HTMLInputElement>('.wd-switcher-input')!;
    type(input, 'k');
    type(input, 'ke');
    type(input, 'keys');
    expect(h.search).not.toHaveBeenCalled(); // not on every keystroke
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0].slice(0, 2)).toEqual(['s1', 'keys']);
    expect([...container.querySelectorAll('.wd-code-search-heading')].map((x) => x.textContent)).toEqual([
      'Types & members',
      'Files',
      'Text · 2',
    ]);
    expect(container.querySelector('mark')!.textContent).toBe('Keys');
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(onClose).toHaveBeenCalled();
    expect(onPick).toHaveBeenCalledWith({ repo: 'api', path: 'src/Keys.cs', line: 2 });
  });

  it('↓ moves to the next place; Esc closes without opening anything', async () => {
    vi.useFakeTimers();
    const onPick = vi.fn();
    const onClose = vi.fn();
    act(() => root.render(createElement(CodeSearch, { sessionId: 's1', onPick, onClose })));
    const input = container.querySelector<HTMLInputElement>('.wd-switcher-input')!;
    type(input, 'keys');
    await act(async () => void (await vi.advanceTimersByTimeAsync(300)));
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(container.querySelector('[aria-selected="true"]')!.textContent).toContain('Keys.cs');
    act(() => void input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('the Code tab opens a picked place', () => {
  it('its file, with the line marked and scrolled to', async () => {
    const session = { id: 'goto-1', target: 'api', branch: 'x', isGroup: false, paths: ['/wt/api'] } as unknown as SessionSummary;
    act(() =>
      root.render(createElement(CodeView, { session, onShowDiff: vi.fn(), goto: { repo: 'api', path: 'src/Keys.cs', line: 7, seq: 1 } })),
    );
    await flush();
    await flush();
    expect(container.querySelector('.wd-code-path')!.textContent).toBe('src/Keys.cs');
    const marked = container.querySelector('.wd-code-line-mark')!;
    expect(marked.getAttribute('data-line')).toBe('7');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    // Its folder opened in the tree.
    expect(container.querySelector('.wd-code-row-open')!.textContent).toBe('Keys.cs');
  });
});
