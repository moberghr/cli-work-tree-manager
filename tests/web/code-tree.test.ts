import { describe, expect, it } from 'vitest';
import {
  codeEntries,
  codeKey,
  codeSidebar,
  entryOf,
  filterEntries,
  foldersOf,
  indexFolders,
  openFolders,
} from '../../src/web/src/state/code-tree.js';
import { demoCodeFile, demoCodeFiles } from '../../src/server/demo/demo-code.js';
import { parseGitDiff } from '../../src/core/diff/diff-parse.js';
import type { CodeFilesWire } from '../../src/core/api-types.js';

const single: CodeFilesWire = {
  group: false,
  rootFiles: [],
  repos: [
    {
      name: 'api',
      files: ['README.md', 'src/app/main.ts', 'src/app/util.ts', 'src/index.ts'],
      changed: ['src/app/util.ts'],
      truncated: false,
    },
  ],
};
const group: CodeFilesWire = {
  group: true,
  rootFiles: ['CLAUDE.md'],
  repos: [
    { name: 'backend', files: ['Program.cs'], changed: [], truncated: false },
    { name: 'frontend', files: ['src/App.tsx'], changed: ['src/App.tsx'], truncated: false },
  ],
};

describe('the Code tab tree', () => {
  it("a search's pick opens a file the listing doesn't have yet, in a repo it knows", () => {
    const listed = new Map(codeEntries(single).map((e) => [e.key, e]));
    expect(entryOf(single, codeKey('api', 'src/index.ts'), listed)).toBe(listed.get(codeKey('api', 'src/index.ts')));
    expect(entryOf(single, codeKey('api', 'src/NewService.ts'))).toEqual({
      key: codeKey('api', 'src/NewService.ts'),
      repo: 'api',
      path: 'src/NewService.ts',
      display: 'src/NewService.ts',
      changed: false,
    });
    expect(entryOf(group, codeKey('frontend', 'src/App.tsx'))?.display).toBe('frontend/src/App.tsx');
    expect(entryOf(group, codeKey('frontend', 'src/App.tsx'))?.changed).toBe(true);
    expect(entryOf(group, codeKey('', 'NOTES.md'))?.display).toBe('NOTES.md');
    expect(entryOf(single, codeKey('', 'NOTES.md'))).toBeNull();
    expect(entryOf(single, codeKey('web', 'a.ts'))).toBeNull();
    expect(entryOf(single, 'no separator')).toBeNull();
  });

  it("a single repo's files are the tree; a group's repos are folders beside its own files", () => {
    expect(codeEntries(single).map((e) => e.display)).toEqual(['README.md', 'src/app/main.ts', 'src/app/util.ts', 'src/index.ts']);
    expect(codeEntries(group).map((e) => e.display)).toEqual(['CLAUDE.md', 'backend/Program.cs', 'frontend/src/App.tsx']);
    expect(codeEntries(group)[0]).toMatchObject({ repo: '', path: 'CLAUDE.md', key: codeKey('', 'CLAUDE.md') });
  });

  it('a folder holds its folders and files, and counts the changed files anywhere under it', () => {
    const index = indexFolders(codeEntries(single));
    expect(index.get('')).toMatchObject({ dirs: ['src'], changed: 1 });
    expect(index.get('')!.files.map((f) => f.path)).toEqual(['README.md']);
    expect(index.get('src')).toMatchObject({ dirs: ['app'], changed: 1 });
    expect(index.get('src/app')!.files.map((f) => [f.path, f.changed])).toEqual([
      ['src/app/main.ts', false],
      ['src/app/util.ts', true],
    ]);
    expect(indexFolders(codeEntries(group)).get('')!.dirs).toEqual(['backend', 'frontend']);
  });

  it('a file opens the folders it is in', () => {
    expect(foldersOf('frontend/src/App.tsx')).toEqual(['frontend', 'frontend/src']);
    expect(foldersOf('README.md')).toEqual([]);
  });

  it('the filter: every word in the path; names starting with the last word first, changed ones first among equals', () => {
    const entries = codeEntries(single);
    expect(filterEntries(entries, 'app').map((e) => e.path)).toEqual(['src/app/util.ts', 'src/app/main.ts']);
    expect(filterEntries(entries, 'src main').map((e) => e.path)).toEqual(['src/app/main.ts']);
    expect(filterEntries(entries, 'ind').map((e) => e.path)).toEqual(['src/index.ts']);
    expect(filterEntries(entries, '   ')).toEqual([]);
    expect(filterEntries(entries, 'zzz')).toEqual([]);
  });
});

describe('the demo', () => {
  const diff = parseGitDiff(
    [
      'diff --git a/src/cart.ts b/src/cart.ts',
      '--- a/src/cart.ts',
      '+++ b/src/cart.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '',
    ].join('\n'),
  );

  it('lists the changed files beside a few every project has, and shows their new side', () => {
    const w = demoCodeFiles([{ name: 'web', changed: diff }], false);
    expect(w.repos[0].files).toContain('src/cart.ts');
    expect(w.repos[0].files).toContain('README.md');
    expect(w.repos[0].changed).toEqual(['src/cart.ts']);
    expect(demoCodeFile([{ name: 'web', changed: diff }], false, 'web', 'src/cart.ts')?.text).toBe('const a = 1;\nconst b = 3;\n');
    expect(demoCodeFile([{ name: 'web', changed: diff }], false, 'web', 'README.md')?.text).toContain('# web');
    expect(demoCodeFile([{ name: 'web', changed: diff }], false, 'web', 'nope.ts')).toBeNull();
  });
});

describe('the Code tab sidebar: changed only, and matches as a list or a tree', () => {
  const entries = codeEntries(single);
  const shown = (v: ReturnType<typeof codeSidebar>) => (v.mode === 'full' ? 'full' : v.entries.map((e) => e.display));

  it('nothing set: the whole tree, as before', () => {
    expect(codeSidebar(entries, { query: '', changedOnly: false, resultsAs: 'list' })).toEqual({ mode: 'full' });
    expect(codeSidebar(entries, { query: '   ', changedOnly: false, resultsAs: 'tree' })).toEqual({ mode: 'full' });
  });

  it('changed only: a tree of just the changed files, their folders open', () => {
    const v = codeSidebar(entries, { query: '', changedOnly: true, resultsAs: 'list' });
    expect(v.mode).toBe('tree');
    expect(shown(v)).toEqual(['src/app/util.ts']);
    if (v.mode !== 'tree') throw new Error('a tree');
    expect([...openFolders(v.index)].sort()).toEqual(['src', 'src/app']);
    expect([...openFolders(v.index, new Set(['src/app']))]).toEqual(['src']); // folded by hand
  });

  it('a filter: the matches as a list, or in their folders; with changed only, among the changed', () => {
    expect(codeSidebar(entries, { query: 'ts', changedOnly: false, resultsAs: 'list' }).mode).toBe('list');
    const tree = codeSidebar(entries, { query: 'app', changedOnly: false, resultsAs: 'tree' });
    expect(tree.mode).toBe('tree');
    expect(shown(tree)).toEqual(expect.arrayContaining(['src/app/main.ts', 'src/app/util.ts']));
    if (tree.mode !== 'tree') throw new Error('a tree');
    expect(tree.index.get('src/app')?.files.map((f) => f.path)).toEqual(['src/app/main.ts', 'src/app/util.ts']);
    expect(shown(codeSidebar(entries, { query: 'app', changedOnly: true, resultsAs: 'list' }))).toEqual(['src/app/util.ts']);
    expect(shown(codeSidebar(entries, { query: 'nothing-like-it', changedOnly: false, resultsAs: 'tree' }))).toEqual([]);
  });

  it("a group's matches are under their repo's folder", () => {
    const v = codeSidebar(codeEntries(group), { query: 'app', changedOnly: false, resultsAs: 'tree' });
    if (v.mode !== 'tree') throw new Error('a tree');
    expect([...openFolders(v.index)].sort()).toEqual(['frontend', 'frontend/src']);
  });
});
