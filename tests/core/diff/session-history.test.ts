import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import { computeSessionRange, sessionHistory } from '../../../src/core/diff/session-history.js';
import { resolveRepoDiff, resolveRepoDiffAsync } from '../../../src/core/diff/diff-scope.js';

const sessionCommits = async (s: Parameters<typeof sessionHistory>[0]) => (await sessionHistory(s)).commits;
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
  it("lists the branch's commits since its base, newest first, by repo", async () => {
    expect((await sessionCommits(session())).map((c) => [c.repo, c.sha, c.subject])).toEqual([
      ['backend', second, 'Add b'],
      ['backend', first, 'Add a'],
    ]);
    expect(Number.isFinite(Date.parse((await sessionCommits(session()))[0].at))).toBe(true);
  });

  it('a recorded base that is gone (merged and deleted): measured from the parent found by itself', async () => {
    expect(await sessionCommits({ paths: [repo], baseBranch: 'no-such-branch' })).toEqual(await sessionCommits(session()));
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
  it('a new commit is listed (the list is kept only while every HEAD stays put)', async () => {
    expect(await sessionCommits(session())).toHaveLength(2);
    write('c.txt', 'c\n');
    const third = commit('Add c');
    expect((await sessionCommits(session())).map((c) => c.sha)).toEqual([third, second, first]);
  });

  it("a checkpoint is found by the session's path written another way (a trailing separator): not read as HEAD", async () => {
    const entry = await takeCheckpoint(scopeHashForPaths([repo]), [{ name: path.resolve(repo), root: repo }]);
    expect(entry).not.toBeNull();
    write('d.txt', 'd\n');
    const r = computeSessionRange({ paths: [repo + path.sep] }, { kind: 'checkpoint', id: entry!.id }, { kind: 'working' });
    expect(paths(r)).toEqual(['d.txt']);
  });
});

describe('the history is kept while nothing moved (no git), and read again once something did', () => {
  it('the same answer twice is the same object; a moved branch tip is a fresh one', async () => {
    const s = session();
    const a = await sessionHistory(s);
    expect(await sessionHistory(s)).toBe(a); // kept: nothing moved
    write('e.txt', 'e\n');
    commit('Add e');
    const b = await sessionHistory(s);
    expect(b).not.toBe(a);
    expect(b.commits[0].subject).toBe('Add e');
  });
});

describe('finding a branch base off the event loop gives what the synchronous lookup gives', () => {
  it('resolveRepoDiffAsync === resolveRepoDiff: a recorded base, one gone, and none', async () => {
    const run = async (args: string[]) => {
      const r = git(args, repo);
      return { exitCode: r.exitCode, stdout: r.stdout };
    };
    for (const base of ['main', 'no-such-branch', undefined]) {
      expect(await resolveRepoDiffAsync('branch', base, run)).toEqual(resolveRepoDiff(repo, 'branch', base));
    }
    expect(await resolveRepoDiffAsync('uncommitted', 'main', run)).toEqual({ resolvedBase: 'HEAD', diffArg: 'HEAD' });
  });
});

describe("another branch's span after merges into it", () => {
  let r2: string;
  const sh = (...a: string[]) => git(a, r2).stdout;
  const put = (rel: string, text: string, msg: string) => {
    fs.writeFileSync(path.join(r2, rel), text);
    sh('add', '.');
    sh('-c', 'user.email=t@t.t', '-c', 'user.name=T', 'commit', '-m', msg, '--no-gpg-sign');
    return sh('rev-parse', 'HEAD');
  };
  beforeAll(() => {
    r2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'work-spans-')), 'api');
    fs.mkdirSync(r2);
    sh('init', '-b', 'main');
    put('base.txt', 'base\n', 'base');
  });
  afterAll(() => fs.rmSync(path.dirname(r2), { recursive: true, force: true }));

  it("a merge of its own copy (pull --no-ff) isn't a base: All of it still starts where its work began", async () => {
    sh('checkout', '-q', '-b', 'feat/y');
    const start = sh('rev-parse', 'HEAD');
    put('mine1.txt', '1\n', 'mine 1');
    // A colleague's copy of the branch: it holds mine 1 and adds theirs.
    sh('checkout', '-q', '-b', 'copy');
    put('theirs.txt', 't\n', 'theirs');
    sh('checkout', '-q', 'feat/y');
    put('mine2.txt', '2\n', 'mine 2');
    sh('-c', 'user.email=t@t.t', '-c', 'user.name=T', 'merge', '--no-ff', '-q', '-m', 'Merge copy', 'copy');
    const tip = sh('rev-parse', 'HEAD');
    sh('checkout', '-q', 'main');
    const h = await sessionHistory({ paths: [r2] }, [{ path: r2, name: 'feat/y', start }]);
    expect(h.spans).toEqual([{ repo: 'api', branch: 'feat/y', base: start, tip }]);
  });

  it('a merge of its base (main into it) is: All of it starts at what it took in', async () => {
    sh('checkout', '-q', '-b', 'feat/z');
    const start = sh('rev-parse', 'HEAD');
    put('z1.txt', '1\n', 'z 1');
    sh('checkout', '-q', 'main');
    const mainNow = put('main2.txt', 'm\n', 'main moves');
    sh('checkout', '-q', 'feat/z');
    sh('-c', 'user.email=t@t.t', '-c', 'user.name=T', 'merge', '--no-ff', '-q', '-m', 'Merge main', 'main');
    const tip = sh('rev-parse', 'HEAD');
    sh('checkout', '-q', 'main');
    const h = await sessionHistory({ paths: [r2] }, [{ path: r2, name: 'feat/z', start }]);
    expect(h.spans).toEqual([{ repo: 'api', branch: 'feat/z', base: mainNow, tip }]);
  });
});
