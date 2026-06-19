// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffFile } from '../../src/web/src/components/Diff/DiffFile.js';
import { DiffModeProvider } from '../../src/web/src/state/DiffModeProvider.js';
import { ReviewProvider } from '../../src/web/src/state/ReviewProvider.js';
import type { ReviewApi } from '../../src/web/src/api/review-api.js';
import type { ParsedFile } from '../../src/web/src/api/client.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

class StubEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

// This jsdom build doesn't expose localStorage; DiffModeProvider reads the
// preference from it. A minimal in-memory shim is enough to drive the test.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

function stubReviewApi(): ReviewApi {
  return {
    fetch: async () => [],
    post: async () => ({ comments: [] }),
    delete: async () => ({ comments: [] }),
    resolve: async () => ({ comments: [] }),
    submit: async () => ({ comments: [], count: 0 }),
    discard: async () => ({ comments: [], discarded: 0 }),
    done: async () => {},
    ssePath: '/events',
  };
}

/** A modified file with one delete+add pair and a trailing context line. */
function modifiedFile(): ParsedFile {
  return {
    path: 'src/example.ts',
    oldPath: 'src/example.ts',
    newPath: 'src/example.ts',
    status: 'modified',
    isBinary: false,
    added: 1,
    deleted: 1,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        context: '',
        lines: [
          { kind: 'delete', content: 'const x = 1;', oldNum: 1, newNum: null },
          { kind: 'add', content: 'const x = 2;', oldNum: null, newNum: 1 },
          { kind: 'context', content: 'return x;', oldNum: 2, newNum: 2 },
        ],
      },
    ],
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  localStorage.clear();
  // The provider initializes from localStorage on mount — preselect unified.
  localStorage.setItem('wd:diff-mode', 'unified');
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
});

function renderUnified(extra: Partial<Parameters<typeof DiffFile>[0]> = {}) {
  act(() => {
    root.render(
      createElement(
        DiffModeProvider,
        null,
        createElement(DiffFile, {
          file: modifiedFile(),
          anchor: 'a',
          ...extra,
        }),
      ),
    );
  });
}

describe('Unified (inline) diff mode', () => {
  it('renders the unified table, not the side-by-side one, when the preference is unified', () => {
    renderUnified();
    expect(container.querySelector('.wd-diff-table.wd-unified')).not.toBeNull();
    expect(container.querySelector('.wd-diff-table.wd-side')).toBeNull();
  });

  it('lays each row out as three cells (old gutter, new gutter, content)', () => {
    renderUnified();
    const firstRow = container.querySelector('.wd-unified tbody tr.wd-row')!;
    expect(firstRow.querySelectorAll('td').length).toBe(3);
  });

  it('interleaves the deletion above the addition, then the context line', () => {
    renderUnified();
    const rows = Array.from(
      container.querySelectorAll('.wd-unified tbody tr.wd-row'),
    );
    // Classify each row by the tint on its content cell.
    const kinds = rows.map((r) => {
      const cell = r.querySelector('td.wd-content')!;
      if (cell.classList.contains('wd-delete')) return 'delete';
      if (cell.classList.contains('wd-add')) return 'add';
      return 'context';
    });
    expect(kinds).toEqual(['delete', 'add', 'context']);
  });

  it('shows the old line number on the deletion and the new one on the addition', () => {
    renderUnified();
    const rows = Array.from(
      container.querySelectorAll('.wd-unified tbody tr.wd-row'),
    );
    const del = rows[0];
    const add = rows[1];
    expect(del.querySelector('.wd-ln-old')!.textContent).toBe('1');
    expect(del.querySelector('.wd-ln-new')!.textContent).toBe('');
    expect(add.querySelector('.wd-ln-old')!.textContent).toBe('');
    expect(add.querySelector('.wd-ln-new')!.textContent).toBe('1');
  });

  it('falls back to the split table when the preference is split', () => {
    localStorage.setItem('wd:diff-mode', 'split');
    renderUnified();
    expect(container.querySelector('.wd-diff-table.wd-side')).not.toBeNull();
    expect(container.querySelector('.wd-diff-table.wd-unified')).toBeNull();
  });

  it('in review mode, clicking a deletion gutter opens a composer on the left side', async () => {
    await act(async () => {
      root.render(
        createElement(
          DiffModeProvider,
          null,
          createElement(
            ReviewProvider,
            { api: stubReviewApi() },
            createElement(DiffFile, {
              file: modifiedFile(),
              anchor: 'a',
              review: true,
              repo: 'myrepo',
            }),
          ),
        ),
      );
    });

    expect(container.querySelector('.wd-comment-form')).toBeNull();

    // The deletion row's old gutter is clickable.
    const delRow = container.querySelector('.wd-unified tbody tr.wd-row')!;
    const gutter = delRow.querySelector<HTMLElement>('.wd-ln-old.wd-ln-clickable');
    expect(gutter).not.toBeNull();

    await act(async () => gutter!.click());

    const composer = container.querySelector('.wd-comment-row .wd-comment-form');
    expect(composer).not.toBeNull();
    // The composer's full-width cell spans the unified table's three columns.
    const cell = container.querySelector('.wd-comment-row td')!;
    expect(cell.getAttribute('colspan')).toBe('3');
  });
});
