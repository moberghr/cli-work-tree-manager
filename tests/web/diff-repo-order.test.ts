// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffRepo } from '../../src/web/src/components/Diff/DiffRepo.js';
import type { ParsedFile, RepoData } from '../../src/web/src/api/client.js';

// React 19 logs a warning unless the test env advertises act support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function file(path: string): ParsedFile {
  return {
    path,
    oldPath: path,
    newPath: path,
    status: 'modified',
    isBinary: false,
    added: 1,
    deleted: 0,
    hunks: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        context: '',
        lines: [{ kind: 'add', content: 'x', oldNum: null, newNum: 1 }],
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

describe('DiffRepo render order', () => {
  it('renders files in directory-grouped, alphabetical (tree) order — not git order', () => {
    // Deliberately scrambled vs the tree's display order: a top-level file
    // before a directory, files out of alphabetical order, a nested dir.
    const repo: RepoData = {
      name: 'repo',
      files: [
        file('zzz.txt'), // index 0 — top-level file, sorts AFTER dirs
        file('src/b.ts'), // index 1
        file('src/a.ts'), // index 2
        file('src/nested/deep.ts'), // index 3
      ],
    } as RepoData;

    act(() => {
      root.render(createElement(DiffRepo, { repo, startIndex: 0 }));
    });

    const ids = Array.from(
      container.querySelectorAll<HTMLElement>('.wd-repo-files [id^="wd-file-"]'),
    ).map((el) => el.id);

    // Tree order: each level mixes dirs + files in one alphabetical list
    // (matches FileTree). At root: "src" (dir) < "zzz.txt". Inside src:
    // "a.ts" < "b.ts" < "nested" (dir). Each id keeps its ORIGINAL array
    // index so tree↔diff anchors line up.
    expect(ids).toEqual([
      'wd-file-2', // src/a.ts
      'wd-file-1', // src/b.ts
      'wd-file-3', // src/nested/deep.ts
      'wd-file-0', // zzz.txt
    ]);
  });

  it('offsets anchor ids by startIndex (multi-repo)', () => {
    const repo: RepoData = {
      name: 'repo',
      files: [file('src/b.ts'), file('src/a.ts')],
    } as RepoData;

    act(() => {
      root.render(createElement(DiffRepo, { repo, startIndex: 10 }));
    });

    const ids = Array.from(
      container.querySelectorAll<HTMLElement>('.wd-repo-files [id^="wd-file-"]'),
    ).map((el) => el.id);
    // a.ts (index 11) before b.ts (index 10), both offset by startIndex.
    expect(ids).toEqual(['wd-file-11', 'wd-file-10']);
  });
});
