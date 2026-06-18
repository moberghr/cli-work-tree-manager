// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffFile } from '../../src/web/src/components/Diff/DiffFile.js';
import { ReviewProvider } from '../../src/web/src/state/ReviewProvider.js';
import type { ReviewApi } from '../../src/web/src/api/review-api.js';
import type { ParsedFile } from '../../src/web/src/api/client.js';

// React 19 logs a warning unless the test env advertises act support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom has no EventSource; ReviewProvider subscribes via useSse on mount.
// A no-op stub keeps the connection lifecycle from throwing.
class StubEventSource {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}
(globalThis as unknown as { EventSource: unknown }).EventSource = StubEventSource;

/** A ReviewApi whose calls all resolve empty — no network, no comments. */
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

/** A new file: one `@@ -0,0 +1,3 @@` hunk of all-add lines. */
function addedFile(over: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: 'src/brand-new.ts',
    oldPath: 'src/brand-new.ts',
    newPath: 'src/brand-new.ts',
    status: 'added',
    isBinary: false,
    added: 3,
    deleted: 0,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        context: '',
        lines: [
          { kind: 'add', content: 'const a = 1;', oldNum: null, newNum: 1 },
          { kind: 'add', content: 'const b = 2;', oldNum: null, newNum: 2 },
          { kind: 'add', content: 'const c = 3;', oldNum: null, newNum: 3 },
        ],
      },
    ],
    ...over,
  };
}

function modifiedFile(): ParsedFile {
  return {
    path: 'src/example.txt',
    oldPath: 'src/example.txt',
    newPath: 'src/example.txt',
    status: 'modified',
    isBinary: false,
    added: 1,
    deleted: 1,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        context: '',
        lines: [
          { kind: 'delete', content: 'old', oldNum: 1, newNum: null },
          { kind: 'add', content: 'new', oldNum: null, newNum: 1 },
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
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('NewFileView (added files render full-width)', () => {
  it('renders an added file with the full-width new-file table, not the side-by-side table', () => {
    act(() => {
      root.render(createElement(DiffFile, { file: addedFile(), anchor: 'a' }));
    });
    expect(container.querySelector('.wd-diff-table.wd-newfile')).not.toBeNull();
    expect(container.querySelector('.wd-diff-table.wd-side')).toBeNull();
  });

  it('renders one content row per added line, all tinted as added', () => {
    act(() => {
      root.render(createElement(DiffFile, { file: addedFile(), anchor: 'a' }));
    });
    const rows = container.querySelectorAll('.wd-newfile tbody tr.wd-row');
    expect(rows.length).toBe(3);
    const lineNumbers = Array.from(
      container.querySelectorAll('.wd-newfile .wd-ln-new'),
    ).map((td) => td.textContent);
    expect(lineNumbers).toEqual(['1', '2', '3']);
    // Each content cell carries the green "added" tint.
    expect(
      container.querySelectorAll('.wd-newfile td.wd-content.wd-add').length,
    ).toBe(3);
  });

  it('still renders a modified file as the side-by-side table', () => {
    act(() => {
      root.render(createElement(DiffFile, { file: modifiedFile(), anchor: 'a' }));
    });
    expect(container.querySelector('.wd-diff-table.wd-side')).not.toBeNull();
    expect(container.querySelector('.wd-diff-table.wd-newfile')).toBeNull();
  });

  it('in review mode, clicking a line number opens the comment composer inline', async () => {
    await act(async () => {
      root.render(
        createElement(
          ReviewProvider,
          { api: stubReviewApi() },
          createElement(DiffFile, {
            file: addedFile(),
            anchor: 'a',
            review: true,
            repo: 'myrepo',
          }),
        ),
      );
    });

    // No composer until a line is clicked.
    expect(container.querySelector('.wd-comment-form')).toBeNull();

    const clickable = container.querySelector<HTMLElement>(
      '.wd-newfile .wd-ln-new.wd-ln-clickable',
    );
    expect(clickable).not.toBeNull();

    await act(async () => clickable!.click());

    const composer = container.querySelector('.wd-comment-row .wd-comment-form');
    expect(composer).not.toBeNull();
    expect(composer!.querySelector('textarea')).not.toBeNull();
  });
});
