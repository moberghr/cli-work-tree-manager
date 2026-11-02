import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preparePr, reviewRef } from '../../../src/core/review/review-source.js';
import { defaultRunner } from '../../../src/core/platform/command-runner.js';
import { kindsOf } from '../../../src/core/review/review-build.js';

/**
 * A PR's code fetched and diffed with no checkout touched: a bare origin
 * with main and a PR branch (a rename, a whitespace-only edit, a file the
 * PR's .gitattributes marks generated, a real change), and a clone that
 * stays on main. The host's PR ref here is the branch itself.
 */

let tmp: string;
let clone: string;
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

  it('a PR ref origin does not have: refused with git’s reason', async () => {
    const r = await preparePr(defaultRunner, clone, { prRef: () => 'refs/heads/nope' }, { number: 13, base: 'main' });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("couldn't fetch the PR's code") });
  }, 60_000);
});
