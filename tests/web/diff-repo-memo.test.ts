// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// Wrap the real buildTree in a spy so we can count how often DiffRepo rebuilds
// the directory tree across re-renders. flattenTreeFiles stays real.
vi.mock('../../src/web/src/utils/tree.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../../src/web/src/utils/tree.js')>();
  return { ...actual, buildTree: vi.fn(actual.buildTree) };
});

import { DiffRepo } from '../../src/web/src/components/Diff/DiffRepo.js';
import { buildTree } from '../../src/web/src/utils/tree.js';
import type { ParsedFile, RepoData } from '../../src/web/src/api/client.js';

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
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('DiffRepo tree-build memoization', () => {
  it('does NOT rebuild the file tree on a re-render with the same files', () => {
    // Stable repo reference across both renders — the memo key (repo.files,
    // startIndex) is unchanged, so the tree must be built at most once.
    const repo: RepoData = {
      name: 'repo',
      files: [file('src/b.ts'), file('src/a.ts'), file('zzz.txt')],
    } as RepoData;

    const node = () => createElement(DiffRepo, { repo, startIndex: 0 });

    act(() => root.render(node()));
    const afterFirst = (buildTree as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;

    // Re-render the same component instance with an equal (same-reference)
    // file list — ReviewApp does this on every scrollspy tick, so an
    // unmemoized buildTree runs again here for the whole file list.
    act(() => root.render(node()));
    const afterSecond = (buildTree as unknown as { mock: { calls: unknown[] } })
      .mock.calls.length;

    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1); // memoized: no extra rebuild on re-render
  });
});
