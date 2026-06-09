// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffFile } from '../../src/web/src/components/Diff/DiffFile.js';
import { ExpandProvider } from '../../src/web/src/state/ExpandProvider.js';
import type { ParsedFile } from '../../src/web/src/api/client.js';

// React 19 logs a warning unless the test env advertises act support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function oneHunk(): ParsedFile['hunks'] {
  return [
    {
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: 1,
      context: '',
      lines: [{ kind: 'add', content: 'hello', oldNum: null, newNum: 1 }],
    },
  ];
}

/** Two hunks, each carrying git's enclosing-function context. When
 *  `adjacent`, the second starts right after the first (no gap); otherwise
 *  they're 20 lines apart (a real gap between them). */
function twoHunks(adjacent: boolean): ParsedFile['hunks'] {
  const secondStart = adjacent ? 2 : 20;
  return [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      context: 'function first()',
      lines: [{ kind: 'context', content: 'a', oldNum: 1, newNum: 1 }],
    },
    {
      oldStart: secondStart,
      oldLines: 1,
      newStart: secondStart,
      newLines: 1,
      context: 'function second()',
      lines: [{ kind: 'context', content: 'b', oldNum: secondStart, newNum: secondStart }],
    },
  ];
}

function hunkHeaderCount(): number {
  return container.querySelectorAll('.wd-hunk-context').length;
}

function makeFile(over: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: 'src/example.txt',
    oldPath: 'src/example.txt',
    newPath: 'src/example.txt',
    status: 'modified',
    isBinary: false,
    added: 1,
    deleted: 0,
    hunks: oneHunk(),
    ...over,
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

function chevron(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('.wd-file-collapse');
  if (!btn) throw new Error('collapse chevron not found');
  return btn;
}
function hasDiffBody(): boolean {
  return container.querySelector('.wd-diff-table') !== null;
}

describe('DiffFile collapse', () => {
  it('renders the diff body expanded by default, with the chevron marked expanded', () => {
    act(() => {
      root.render(createElement(DiffFile, { file: makeFile(), anchor: 'a' }));
    });
    expect(hasDiffBody()).toBe(true);
    expect(chevron().getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses the body when the chevron is clicked, and re-expands on a second click', () => {
    act(() => {
      root.render(createElement(DiffFile, { file: makeFile(), anchor: 'a' }));
    });

    act(() => chevron().click());
    expect(hasDiffBody()).toBe(false);
    expect(chevron().getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('.wd-file')?.classList.contains('wd-file-collapsed'),
    ).toBe(true);

    act(() => chevron().click());
    expect(hasDiffBody()).toBe(true);
    expect(chevron().getAttribute('aria-expanded')).toBe('true');
  });

  it('starts collapsed when the file is already marked viewed', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile(),
          anchor: 'a',
          viewed: true,
          onToggleViewed: () => {},
        }),
      );
    });
    expect(hasDiffBody()).toBe(false);
    expect(chevron().getAttribute('aria-expanded')).toBe('false');
  });

  it('auto-collapses a deleted file by default (still expandable via the chevron)', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile({ status: 'deleted', added: 0, deleted: 3 }),
          anchor: 'a',
        }),
      );
    });
    expect(hasDiffBody()).toBe(false);
    expect(chevron().getAttribute('aria-expanded')).toBe('false');

    act(() => chevron().click());
    expect(hasDiffBody()).toBe(true);
  });

  it('auto-collapses a rename with no content changes', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile({
            status: 'renamed',
            oldPath: 'src/old.txt',
            newPath: 'src/new.txt',
            path: 'src/new.txt',
            added: 0,
            deleted: 0,
            hunks: [],
          }),
          anchor: 'a',
        }),
      );
    });
    expect(chevron().getAttribute('aria-expanded')).toBe('false');
    // Header still shows the rename transition even while folded.
    expect(container.querySelector('.wd-rename')?.textContent).toContain(
      'src/old.txt',
    );
  });

  it('keeps a rename WITH content changes expanded by default', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile({
            status: 'renamed',
            oldPath: 'src/old.txt',
            newPath: 'src/new.txt',
            path: 'src/new.txt',
            added: 1,
            deleted: 0,
            hunks: oneHunk(),
          }),
          anchor: 'a',
        }),
      );
    });
    expect(hasDiffBody()).toBe(true);
    expect(chevron().getAttribute('aria-expanded')).toBe('true');
  });

  it('shows each hunk its own @@ heading when a gap separates them (no provider)', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile({ hunks: twoHunks(false) }),
          anchor: 'a',
          repo: 'repo',
        }),
      );
    });
    expect(hunkHeaderCount()).toBe(2);
    // Full `@@ … @@` heading is shown (GitHub parity), with the context.
    expect(container.textContent).toContain('@@ -1,1 +1,1 @@ function first()');
    expect(container.textContent).toContain('function second()');
  });

  it('suppresses the second heading when the hunks are adjacent (no gap)', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile({ hunks: twoHunks(true) }),
          anchor: 'a',
          repo: 'repo',
        }),
      );
    });
    // Contiguous lines → the second separator would interrupt the run.
    expect(hunkHeaderCount()).toBe(1);
    expect(container.textContent).toContain('function first()');
    expect(container.textContent).not.toContain('function second()');
  });

  it('merges the below-hunk @@ heading onto the gap expander bar when expandable (GitHub-style)', () => {
    act(() => {
      root.render(
        createElement(
          ExpandProvider,
          null,
          createElement(DiffFile, {
            file: makeFile({ hunks: twoHunks(false) }),
            anchor: 'a',
            repo: 'repo',
          }),
        ),
      );
    });
    // The gap's expander bar exists and carries the below-hunk full heading.
    const bar = container.querySelector('.wd-expander');
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain('@@');
    expect(bar!.textContent).toContain('function second()');
    // The second hunk does NOT also render its own heading — appears once.
    const occurrences =
      container.textContent!.split('function second()').length - 1;
    expect(occurrences).toBe(1);
    // The first hunk (no gap above it) still shows its own heading bar.
    expect(container.textContent).toContain('function first()');
  });

  it('still shows the @@ heading for a hunk with no function context', () => {
    act(() => {
      root.render(
        createElement(DiffFile, {
          file: makeFile({ hunks: oneHunk() }), // oneHunk has empty context
          anchor: 'a',
          repo: 'repo',
        }),
      );
    });
    expect(hunkHeaderCount()).toBe(1);
    expect(container.textContent).toContain('@@ -1,0 +1,1 @@');
  });

  it('expands when "viewed" is turned off after being on (GitHub parity)', () => {
    // Parent owns `viewed`; flipping it false should re-expand the body.
    function Wrapper() {
      const [viewed, setViewed] = useState(true);
      return createElement('div', null, [
        createElement('button', {
          key: 'unview',
          id: 'unview',
          onClick: () => setViewed(false),
        }),
        createElement(DiffFile, {
          key: 'file',
          file: makeFile(),
          anchor: 'a',
          viewed,
          onToggleViewed: () => {},
        }),
      ]);
    }
    act(() => {
      root.render(createElement(Wrapper));
    });
    expect(hasDiffBody()).toBe(false);

    act(() => {
      container.querySelector<HTMLButtonElement>('#unview')!.click();
    });
    expect(hasDiffBody()).toBe(true);
    expect(chevron().getAttribute('aria-expanded')).toBe('true');
  });
});
