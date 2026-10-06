import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import { computeSessionRange, sessionCommits } from '../../../src/core/diff/session-history.js';
import type { DiffPoint } from '../../../src/core/diff/diff-points.js';
import { takeCheckpoint } from '../../../src/core/diff/checkpoint.js';
import { scopeHashForPaths } from '../../../src/core/diff/scope-manager.js';

/**
 * A branch with two commits since main and one uncommitted change: what the
 * Diff tab's picker lists (`sessionCommits`), and the ranges it asks for
 * (`computeSessionRange`) — a commit alone, a commit to the working tree,
 * and the uncommitted change.
 */
let repo: string;
let first: string;
let second: string;
const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);
const commit = (msg: string) => {
  git(['add', '.'], repo);
  git(['commit', '-m', msg, '--no-gpg-sign'], repo);
  return git(['rev-parse', 'HEAD'], repo).stdout;
};

beforeAll(() => {
  repo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-history-')), 'backend');
  fs.mkdirSync(repo);
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'Test'], repo);
  write('base.txt', 'base\n');
  commit('base');
  git(['checkout', '-b', 'feat/x'], repo);
  write('a.txt', 'a\n');
  first = commit('Add a');
  write('b.txt', 'b\n');
  second = commit('Add b');
  write('base.txt', 'base\nedited\n');
});
afterAll(() => fs.rmSync(path.dirname(repo), { recursive: true, force: true }));

const session = () => ({ paths: [repo], baseBranch: 'main' });
const paths = (r: ReturnType<typeof computeSessionRange>): string[] =>
  'error' in r ? [r.error] : r.repos.flatMap((x) => x.files.map((f) => f.path));

describe('sessionCommits', () => {
  it("lists the branch's commits since its base, newest first, by repo", () => {
    expect(sessionCommits(session()).map((c) => [c.repo, c.sha, c.subject])).toEqual([
      ['backend', second, 'Add b'],
      ['backend', first, 'Add a'],
    ]);
    expect(Number.isFinite(Date.parse(sessionCommits(session())[0].at))).toBe(true);
  });

  it('a repo with no base to measure from lists none', () => {
    expect(sessionCommits({ paths: [repo], baseBranch: 'no-such-branch' })).toEqual([]);
  });
});

describe('computeSessionRange', () => {
  const c = (sha: string): DiffPoint => ({ kind: 'commit', repo: 'backend', sha });
  const p = (sha: string): DiffPoint => ({ kind: 'parent', repo: 'backend', sha });

  it('a commit alone: only what it changed', () => {
    expect(paths(computeSessionRange(session(), p(first), c(first)))).toEqual(['a.txt']);
    expect(paths(computeSessionRange(session(), p(second), c(second)))).toEqual(['b.txt']);
  });

  it('from a commit to the working tree: it, the commits after it, and what is uncommitted', () => {
    expect(paths(computeSessionRange(session(), p(first), { kind: 'working' })).sort()).toEqual(['a.txt', 'b.txt', 'base.txt']);
  });

  it('HEAD to the working tree: the uncommitted change', () => {
    expect(paths(computeSessionRange(session(), { kind: 'head' }, { kind: 'working' }))).toEqual(['base.txt']);
  });

  it('an unknown repo is refused, not diffed', () => {
    expect(computeSessionRange(session(), { kind: 'parent', repo: 'frontend', sha: first }, { kind: 'working' })).toEqual({
      error: 'unknown repo frontend',
    });
  });
});

// Last: these move the shared repo on.
describe('as the repo moves on', () => {
  it('a new commit is listed (the list is kept only while every HEAD stays put)', () => {
    expect(sessionCommits(session())).toHaveLength(2);
    write('c.txt', 'c\n');
    const third = commit('Add c');
    expect(sessionCommits(session()).map((c) => c.sha)).toEqual([third, second, first]);
  });

  it("a checkpoint is found by the session's path written another way (a trailing separator): not read as HEAD", async () => {
    const entry = await takeCheckpoint(scopeHashForPaths([repo]), [{ name: path.resolve(repo), root: repo }]);
    expect(entry).not.toBeNull();
    write('d.txt', 'd\n');
    const r = computeSessionRange({ paths: [repo + path.sep] }, { kind: 'checkpoint', id: entry!.id }, { kind: 'working' });
    expect(paths(r)).toEqual(['d.txt']);
  });
});
