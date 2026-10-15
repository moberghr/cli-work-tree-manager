import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import {
  clearCodeListCache,
  groupRoot,
  isListed,
  listCodeFiles,
  MAX_CODE_FILE_BYTES,
  readCodeFile,
} from '../../../src/core/worktree/code-browse.js';

let tmp: string;
let repo: string;

/** A repo on main with a commit; then a branch with one commit of its own, an edit, a new file and an ignored one. */
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-browse-'));
  repo = path.join(tmp, 'grp', 'api');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 't'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# api\n');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
  git(['checkout', '-b', 'feat/x'], repo);
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'b', '--no-gpg-sign'], repo);
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 3;\n'); // uncommitted edit
  fs.writeFileSync(path.join(repo, 'src', 'new.ts'), 'new\n'); // new, not ignored
  fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n'); // ignored
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'i.js'), '');
  fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  fs.writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(MAX_CODE_FILE_BYTES + 1));
  fs.writeFileSync(path.join(tmp, 'grp', 'CLAUDE.md'), '# group\n');
  // Not a repo, so nothing says what's ignored: local settings copied there aren't shown.
  fs.writeFileSync(path.join(tmp, 'grp', '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(tmp, 'grp', 'appsettings.Development.json'), '{"Password":"x"}\n');
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'not yours\n');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => clearCodeListCache());

const single = () => ({ paths: [repo], isGroup: false, baseBranch: 'main' });

describe('changed on the branch: from the freshest copy of its base', () => {
  it("a local main weeks behind origin's doesn't mark main's own changes", async () => {
    const r = path.join(tmp, 'fresh');
    fs.mkdirSync(r);
    git(['init', '-b', 'main'], r);
    git(['config', 'user.email', 't@t.t'], r);
    git(['config', 'user.name', 't'], r);
    fs.writeFileSync(path.join(r, 'a.ts'), 'a\n');
    git(['add', '.'], r);
    git(['commit', '-m', 'init', '--no-gpg-sign'], r);
    git(['checkout', '-q', '-b', 'upstream'], r);
    fs.writeFileSync(path.join(r, 'mains-own.ts'), 'm\n'); // landed on main since, through origin
    git(['add', '.'], r);
    git(['commit', '-m', 'main moved', '--no-gpg-sign'], r);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], r);
    git(['checkout', '-q', '-b', 'feat/x', 'origin/main'], r); // the branch has origin's news
    fs.writeFileSync(path.join(r, 'mine.ts'), 'x\n');
    git(['add', '.'], r);
    git(['commit', '-m', 'mine', '--no-gpg-sign'], r);
    const w = await listCodeFiles({ paths: [r], isGroup: false, baseBranch: 'main' }); // local main: still at init
    expect(w.repos[0].changed).toEqual(['mine.ts']);
  });

  it('a recorded base that is gone (merged and deleted) counts from the main branch, not from nowhere', async () => {
    const r = path.join(tmp, 'gone-base');
    fs.cpSync(repo, r, { recursive: true });
    git(['update-ref', 'refs/remotes/origin/main', 'main'], r);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], r);
    const w = await listCodeFiles({ paths: [r], isGroup: false, baseBranch: 'feat/parent' }); // no such branch any more
    expect(w.repos[0].changed).toContain('src/b.ts'); // committed on the branch
    expect(w.repos[0].changed).not.toContain('README.md');
  });
});

describe('listCodeFiles', () => {
  it("lists what git does — tracked, and new files that aren't ignored — and marks what changed on the branch", async () => {
    const w = await listCodeFiles(single());
    expect(w.group).toBe(false);
    expect(w.repos).toHaveLength(1);
    const r = w.repos[0];
    expect(r.name).toBe('api');
    expect(r.files).toEqual(['.gitignore', 'README.md', 'big.txt', 'logo.png', 'src/a.ts', 'src/b.ts', 'src/new.ts']);
    expect(r.files).not.toContain('.env');
    // Committed on the branch (b.ts), edited (a.ts), new (new.ts, and the untracked big.txt / logo.png).
    expect(r.changed).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/new.ts']));
    expect(r.changed).not.toContain('README.md');
  });

  it("a group: each repo by its folder's name, and the group folder's own files", async () => {
    const w = await listCodeFiles({ paths: [repo], isGroup: true });
    expect(w.group).toBe(true);
    expect(groupRoot({ paths: [repo], isGroup: true })).toBe(path.dirname(repo));
    expect(w.rootFiles).toEqual(['CLAUDE.md']);
  });
});

describe('a file deleted from the folder (not committed yet)', () => {
  it("isn't listed, and one gone since it was listed reads as not listed, not as an error", async () => {
    const r = path.join(tmp, 'del');
    fs.mkdirSync(r);
    git(['init', '-b', 'main'], r);
    git(['config', 'user.email', 't@t.t'], r);
    git(['config', 'user.name', 't'], r);
    fs.writeFileSync(path.join(r, 'keep.ts'), 'k\n');
    fs.writeFileSync(path.join(r, 'old.ts'), 'o\n');
    git(['add', '.'], r);
    git(['commit', '-m', 'init', '--no-gpg-sign'], r);
    fs.rmSync(path.join(r, 'old.ts'));
    const s = { paths: [r], isGroup: false };
    expect((await listCodeFiles(s)).repos[0].files).toEqual(['keep.ts']);
    const listed = await listCodeFiles(s); // listed, then gone before it's read
    expect(listed.repos[0].files).toContain('keep.ts');
    fs.rmSync(path.join(r, 'keep.ts'));
    expect(await readCodeFile(s, 'del', 'keep.ts')).toEqual({ error: 'not listed' });
  });
});

describe('readCodeFile', () => {
  it('reads a listed file as it is now', async () => {
    expect(await readCodeFile(single(), 'api', 'src/a.ts')).toMatchObject({ text: 'export const a = 3;\n', repo: 'api', path: 'src/a.ts' });
  });

  it("never what isn't listed: an ignored file, a way out with .., another folder", async () => {
    expect(await readCodeFile(single(), 'api', '.env')).toEqual({ error: 'not listed' });
    expect(await readCodeFile(single(), 'api', '../../outside.txt')).toEqual({ error: 'not listed' });
    expect(await readCodeFile(single(), 'web', 'src/a.ts')).toEqual({ error: 'unknown repo' });
    expect(await readCodeFile(single(), '', 'CLAUDE.md')).toEqual({ error: 'unknown repo' }); // not a group
  });

  it('a binary file and a big one are named, not shown', async () => {
    expect(await readCodeFile(single(), 'api', 'logo.png')).toMatchObject({ text: null, reason: 'binary' });
    expect(await readCodeFile(single(), 'api', 'big.txt')).toMatchObject({ text: null, reason: 'too-large' });
  });

  it('one file is asked about alone once the listing is stale: exactly that path, never a folder', async () => {
    expect(await isListed(repo, 'src/a.ts')).toBe(true);
    expect(await isListed(repo, 'src/new.ts')).toBe(true); // new, not ignored
    expect(await isListed(repo, '.env')).toBe(false); // ignored
    expect(await isListed(repo, 'src')).toBe(false); // a folder
    expect(await isListed(repo, 'src/*.ts')).toBe(false); // no pattern
    expect(await isListed(repo, 'nope.ts')).toBe(false);
  });

  it("a group folder's own file", async () => {
    expect(await readCodeFile({ paths: [repo], isGroup: true }, '', 'CLAUDE.md')).toMatchObject({ text: '# group\n' });
    expect(await readCodeFile({ paths: [repo], isGroup: true }, '', '../outside.txt')).toEqual({ error: 'not listed' });
    expect(await readCodeFile({ paths: [repo], isGroup: true }, '', '.env')).toEqual({ error: 'not listed' });
    expect(await readCodeFile({ paths: [repo], isGroup: true }, '', 'appsettings.Development.json')).toEqual({ error: 'not listed' });
  });
});
