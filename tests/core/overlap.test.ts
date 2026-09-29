import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { findOverlaps, MAX_OVERLAP_FILES, type SessionFiles } from '../../src/core/overlap.js';
import { computeChanges } from '../../src/core/diff-stat.js';
import { git } from '../../src/core/git.js';

const sess = (id: string, touched: SessionFiles['touched']): SessionFiles => ({ id, target: 'api', branch: `feat/${id}`, touched });

describe('findOverlaps', () => {
  it('pairs sessions that change the same file of the same repo, both ways', () => {
    const o = findOverlaps([
      sess('a', [{ repoKey: '/r/api.git', name: 'api', files: ['package.json', 'src/a.ts'] }]),
      sess('b', [{ repoKey: '/r/api.git', name: 'api', files: ['package.json', 'src/b.ts'] }]),
      sess('c', [{ repoKey: '/r/api.git', name: 'api', files: ['src/c.ts'] }]),
    ]);
    expect(o.get('a')).toEqual([{ sessionId: 'b', target: 'api', branch: 'feat/b', count: 1, files: [{ repo: 'api', path: 'package.json' }] }]);
    expect(o.get('b')?.map((x) => x.sessionId)).toEqual(['a']);
    expect(o.has('c')).toBe(false);
  });

  it('the same path in two different repos is not an overlap', () => {
    const o = findOverlaps([
      sess('a', [{ repoKey: '/r/api.git', name: 'api', files: ['package.json'] }]),
      sess('b', [{ repoKey: '/r/web.git', name: 'web', files: ['package.json'] }]),
    ]);
    expect(o.size).toBe(0);
  });

  it('a group overlaps through any of its repos; most-overlapping first; files capped', () => {
    const many = Array.from({ length: 30 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
    const o = findOverlaps([
      sess('group', [
        { repoKey: '/r/backend.git', name: 'backend', files: ['api.ts'] },
        { repoKey: '/r/frontend.git', name: 'frontend', files: many },
      ]),
      sess('small', [{ repoKey: '/r/backend.git', name: 'backend', files: ['api.ts'] }]),
      sess('big', [{ repoKey: '/r/frontend.git', name: 'frontend', files: many }]),
    ]);
    const g = o.get('group')!;
    expect(g.map((x) => [x.sessionId, x.count])).toEqual([['big', 30], ['small', 1]]);
    expect(g[0].files).toHaveLength(MAX_OVERLAP_FILES);
    expect(g[1].files).toEqual([{ repo: 'backend', path: 'api.ts' }]);
  });
});

describe('computeChanges on real worktrees', () => {
  let dir: string;
  let main: string;
  let wtA: string;
  let wtB: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-'));
    main = path.join(dir, 'repo');
    fs.mkdirSync(main);
    git(['init', '-q', '-b', 'main'], main);
    fs.writeFileSync(path.join(main, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(main, 'other.ts'), 'x\n');
    git(['add', '.'], main);
    git(['commit', '-q', '-m', 'init'], main);
    // Fake a remote default branch so the fork point is found.
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], main);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], main);
    wtA = path.join(dir, 'a');
    wtB = path.join(dir, 'b');
    git(['worktree', 'add', '-q', '-b', 'feat/a', wtA], main);
    git(['worktree', 'add', '-q', '-b', 'feat/b', wtB], main);
    // A commits its package.json change; B leaves its own uncommitted and adds a new file.
    fs.writeFileSync(path.join(wtA, 'package.json'), '{"a":1}\n');
    git(['commit', '-q', '-am', 'a'], wtA);
    fs.writeFileSync(path.join(wtB, 'package.json'), '{"b":1}\n');
    fs.writeFileSync(path.join(wtB, 'new.ts'), 'n\n');
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  it('finds committed, uncommitted and untracked files, keyed by the shared repo', async () => {
    const a = await computeChanges([wtA], ['api']);
    const b = await computeChanges([wtB], ['api']);
    expect(a.touched).toHaveLength(1);
    expect(a.touched[0].files).toEqual(['package.json']); // committed on the branch
    expect(b.touched[0].files).toEqual(['new.ts', 'package.json']);
    expect(a.touched[0].repoKey).toBe(b.touched[0].repoKey); // two worktrees, one repo
    expect(a.stat).toEqual({ added: 0, deleted: 0, files: 0 }); // the row badge stays "vs HEAD"

    const o = findOverlaps([
      { id: 'a', target: 'api', branch: 'feat/a', touched: a.touched },
      { id: 'b', target: 'api', branch: 'feat/b', touched: b.touched },
    ]);
    expect(o.get('a')?.[0].files).toEqual([{ repo: 'api', path: 'package.json' }]);
  });
});
