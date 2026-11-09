import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ATTR_CHUNK, diffExtras, dropReviewRef, preparePr, reviewRef } from '../../../src/core/review/review-source.js';
import { defaultRunner, type CommandRunner } from '../../../src/core/platform/command-runner.js';
import type { ParsedFile } from '../../../src/core/diff/diff-parse.js';
import { kindsOf } from '../../../src/core/review/review-build.js';

/**
 * A PR's code fetched and diffed with no checkout touched: a bare origin
 * with main and a PR branch (a rename, a whitespace-only edit, a file the
 * PR's .gitattributes marks generated, a real change), and a clone that
 * stays on main. The host's PR ref here is the branch itself.
 */

let tmp: string;
let clone: string;
let featTip: string;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-src-')));
  const bare = path.join(tmp, 'origin.git');
  const work = path.join(tmp, 'author');
  git(tmp, 'init', '--bare', '-q', '-b', 'main', bare);
  git(tmp, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [
    ['user.email', 'a@example.com'],
    ['user.name', 'A'],
    ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'],
  ])
    git(work, 'config', k, v);
  git(work, 'remote', 'add', 'origin', bare);
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src', 'Old.cs'), 'class Old {\n  int A() => 1;\n}\n');
  fs.writeFileSync(path.join(work, 'src', 'Spaces.cs'), 'class Spaces {\n  int B() => 2;\n}\n');
  fs.writeFileSync(path.join(work, 'src', 'Logic.cs'), 'class Logic {\n  int C() => 3;\n}\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feat/x');
  git(work, 'mv', 'src/Old.cs', 'src/Renamed.cs');
  fs.writeFileSync(path.join(work, 'src', 'Spaces.cs'), 'class Spaces {\n    int B() => 2;\n}\n');
  fs.writeFileSync(path.join(work, 'src', 'Logic.cs'), 'class Logic {\n  int C() => 4;\n}\n');
  fs.writeFileSync(path.join(work, '.gitattributes'), 'src/Client.cs linguist-generated=true\n');
  fs.writeFileSync(path.join(work, 'src', 'Client.cs'), 'class Client {}\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'the PR');
  git(work, 'push', '-q', 'origin', 'feat/x');
  // Azure DevOps' PR ref: the PR merged into its target (main first, the PR's head second).
  git(work, 'checkout', '-q', '-b', 'pr-merge', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'Merged PR 7', 'feat/x');
  git(work, 'push', '-q', 'origin', 'HEAD:refs/pull/7/merge');
  featTip = git(work, 'rev-parse', 'feat/x');
  clone = path.join(tmp, 'mine');
  git(tmp, 'clone', '-q', bare, clone);
}, 60_000);

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('preparePr', () => {
  it('fetches the PR into its own ref, diffs it from the merge-base, and says what is whitespace-only and generated', async () => {
    const r = await preparePr(defaultRunner, clone, { prRef: () => 'refs/heads/feat/x' }, { number: 12, base: 'main' });
    if (!r.ok) throw new Error(r.error);
    expect(git(clone, 'rev-parse', reviewRef(12))).toBe(r.headSha);
    expect(git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main'); // the checkout is untouched
    expect(r.files.map((f) => [f.path, f.status]).sort()).toEqual([
      ['.gitattributes', 'added'],
      ['src/Client.cs', 'added'],
      ['src/Logic.cs', 'modified'],
      ['src/Renamed.cs', 'renamed'],
      ['src/Spaces.cs', 'modified'],
    ]);
    expect([...r.extras.whitespaceOnly]).toEqual(['src/Spaces.cs']);
    expect([...r.extras.generated]).toEqual(['src/Client.cs']);
    const kinds = Object.fromEntries(kindsOf(r.files, r.extras).map((k) => [k.path, `${k.kind}: ${k.why}`]));
    expect(kinds).toMatchObject({
      'src/Renamed.cs': 'mechanical: pure rename from src/Old.cs',
      'src/Spaces.cs': 'mechanical: whitespace only',
      'src/Client.cs': 'generated: marked generated in .gitattributes',
      'src/Logic.cs': 'logic: no rule matched: hand-written code',
    });
  }, 60_000);

  it("a merge ref (Azure DevOps): the review is read at the PR's head, its second parent — never at the merge commit", async () => {
    const r = await preparePr(defaultRunner, clone, { prRef: () => 'refs/pull/7/merge', prRefIsMerge: true }, { number: 7, base: 'main' });
    if (!r.ok) throw new Error(r.error);
    expect(r.headSha).toBe(featTip);
    expect(git(clone, 'rev-parse', reviewRef(7))).toBe(featTip); // the diff view and the comments' lines come from it
    expect(r.files.map((f) => f.path).sort()).toEqual([
      '.gitattributes',
      'src/Client.cs',
      'src/Logic.cs',
      'src/Renamed.cs',
      'src/Spaces.cs',
    ]);
    // A ref that is no merge has no second parent: refused, not read at the wrong commit.
    const bad = await preparePr(
      defaultRunner,
      clone,
      { prRef: () => 'refs/heads/feat/x', prRefIsMerge: true },
      { number: 8, base: 'main' },
    );
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('no second parent') });
  }, 60_000);

  it('a review gone: its fetched code goes too', async () => {
    await preparePr(defaultRunner, clone, { prRef: () => 'refs/heads/feat/x' }, { number: 14, base: 'main' });
    expect(git(clone, 'for-each-ref', reviewRef(14))).not.toBe('');
    await dropReviewRef(defaultRunner, clone, 14);
    expect(git(clone, 'for-each-ref', reviewRef(14))).toBe('');
  }, 60_000);

  it('a big PR: check-attr gets its paths in chunks (one command line would pass Windows’ limit), every chunk read', async () => {
    const files = Array.from({ length: 2 * ATTR_CHUNK + 50 }, (_, i) => ({ path: `src/F${i}.cs`, added: 1, deleted: 0 }) as ParsedFile);
    const attrCalls: string[][] = [];
    const run: CommandRunner = async (_cmd, args) => {
      if (args[0] === 'diff') return { code: 0, stdout: files.map((f) => f.path).join('\n'), stderr: '' };
      const paths = args.slice(args.indexOf('--') + 1);
      attrCalls.push(paths);
      // The last file of each chunk is marked generated.
      return {
        code: 0,
        stdout: paths.map((p, i) => `${p}: linguist-generated: ${i === paths.length - 1 ? 'set' : 'unspecified'}`).join('\n'),
        stderr: '',
      };
    };
    const extras = await diffExtras(run, '/repo', 'base', 'head', files);
    expect(attrCalls.map((c) => c.length)).toEqual([ATTR_CHUNK, ATTR_CHUNK, 50]);
    expect(attrCalls.flat()).toEqual(files.map((f) => f.path));
    expect([...extras.generated]).toEqual([`src/F${ATTR_CHUNK - 1}.cs`, `src/F${2 * ATTR_CHUNK - 1}.cs`, `src/F${2 * ATTR_CHUNK + 49}.cs`]);
    // An older git that refuses --source: no file marked, and no more chunks asked.
    attrCalls.length = 0;
    const old: CommandRunner = async (_cmd, args) =>
      args[0] === 'check-attr' ? (attrCalls.push([]), { code: 129, stdout: '', stderr: 'unknown option' }) : run(_cmd, args, '');
    expect([...(await diffExtras(old, '/repo', 'base', 'head', files)).generated]).toEqual([]);
    expect(attrCalls).toHaveLength(1);
  });

  it('a PR ref origin does not have: refused with git’s reason', async () => {
    const r = await preparePr(defaultRunner, clone, { prRef: () => 'refs/heads/nope' }, { number: 13, base: 'main' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("couldn't fetch the PR's code") });
  }, 60_000);
});
