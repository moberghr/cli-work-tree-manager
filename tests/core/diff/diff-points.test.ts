import { describe, expect, it } from 'vitest';
import { parsePoint, pointParam, rangeRefs, type DiffPoint } from '../../../src/core/diff/diff-points.js';

const SHA = '604e66a1b2c3d4e5f60718293a4b5c6d7e8f9012';

describe('parsePoint / pointParam', () => {
  it('reads every kind, and writes it back the same', () => {
    const points: DiffPoint[] = [
      { kind: 'checkpoint', id: 3 },
      { kind: 'commit', repo: 'backend', sha: SHA },
      { kind: 'parent', repo: 'acme-frontend-ai', sha: '604e66a' },
      { kind: 'head' },
      { kind: 'working' },
    ];
    for (const p of points) expect(parsePoint(pointParam(p))).toEqual(p);
    // A folder with spaces (common on Windows) is a repo name like any other.
    expect(parsePoint(`c:My App:${SHA}`)).toEqual({ kind: 'commit', repo: 'My App', sha: SHA });
    // A bare id, as before: a checkpoint.
    expect(parsePoint('2')).toEqual({ kind: 'checkpoint', id: 2 });
  });

  it('refuses anything git could read as more than a commit: options, refs, paths, odd repo names', () => {
    for (const raw of [
      '',
      'cp:-1',
      'c:backend:--output=x',
      'c:backend:HEAD~1',
      'c:backend:main',
      'c:backend:604e66', // too short to be a name
      'c:-x:604e66a',
      'c:a/b:604e66a',
      'c:backend:604e66a:extra',
      'x:backend:604e66a',
    ])
      expect(parsePoint(raw), raw).toBeNull();
  });
});

describe('rangeRefs', () => {
  const paths = ['/wt/shop/backend', '/wt/shop/frontend'];
  const checkpoints = [
    { id: 0, repos: { '/wt/shop/backend': 'b0', '/wt/shop/frontend': 'f0' } },
    { id: 1, repos: { '/wt/shop/backend': 'b1', '/wt/shop/frontend': null } },
  ];
  const cp = (id: number): DiffPoint => ({ kind: 'checkpoint', id });

  it('checkpoints, HEAD and the working tree cover every repo (a repo with no snapshot: its HEAD)', () => {
    expect(rangeRefs(paths, checkpoints, cp(0), cp(1))).toEqual([
      { name: 'backend', root: '/wt/shop/backend', fromRef: 'b0', toRef: 'b1' },
      { name: 'frontend', root: '/wt/shop/frontend', fromRef: 'f0', toRef: 'HEAD' },
    ]);
    expect(rangeRefs(paths, checkpoints, { kind: 'head' }, { kind: 'working' })).toEqual([
      { name: 'backend', root: '/wt/shop/backend', fromRef: 'HEAD', toRef: 'working' },
      { name: 'frontend', root: '/wt/shop/frontend', fromRef: 'HEAD', toRef: 'working' },
    ]);
  });

  it("a commit is its repo's alone: just that commit, or from it to a turn or the working tree", () => {
    const parent: DiffPoint = { kind: 'parent', repo: 'frontend', sha: SHA };
    const commit: DiffPoint = { kind: 'commit', repo: 'frontend', sha: SHA };
    expect(rangeRefs(paths, checkpoints, parent, commit)).toEqual([
      { name: 'frontend', root: '/wt/shop/frontend', fromRef: `${SHA}^`, toRef: SHA },
    ]);
    expect(rangeRefs(paths, checkpoints, parent, { kind: 'working' })).toEqual([
      { name: 'frontend', root: '/wt/shop/frontend', fromRef: `${SHA}^`, toRef: 'working' },
    ]);
    expect(rangeRefs(paths, checkpoints, cp(0), commit)).toEqual([
      { name: 'frontend', root: '/wt/shop/frontend', fromRef: 'f0', toRef: SHA },
    ]);
  });

  it('refuses what has no answer: working as a start, commits of two repos, an unknown repo or checkpoint, a reversed range', () => {
    const err = (from: DiffPoint, to: DiffPoint) => (rangeRefs(paths, checkpoints, from, to) as { error?: string }).error;
    expect(err({ kind: 'working' }, cp(1))).toMatch(/only end/);
    expect(err({ kind: 'parent', repo: 'backend', sha: SHA }, { kind: 'commit', repo: 'frontend', sha: SHA })).toMatch(/one repo/);
    expect(err({ kind: 'parent', repo: 'docs', sha: SHA }, { kind: 'working' })).toMatch(/unknown repo docs/);
    expect(err(cp(7), { kind: 'working' })).toMatch(/unknown checkpoint 7/);
    expect(err(cp(1), cp(0))).toMatch(/must be >=/);
  });

  it("the demo's checkpoints are keyed by repo name, not path: read either", () => {
    expect(rangeRefs(['~/worktrees/shop/backend'], [{ id: 1, repos: { backend: 'b1' } }], cp(1), { kind: 'working' })).toEqual([
      { name: 'backend', root: '~/worktrees/shop/backend', fromRef: 'b1', toRef: 'working' },
    ]);
  });
});
