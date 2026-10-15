import { describe, expect, it } from 'vitest';
import { codeEntries, codeKey, entryOf, filterEntries, foldersOf, indexFolders } from '../../src/web/src/state/code-tree.js';
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
