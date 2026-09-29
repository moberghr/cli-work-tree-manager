import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { git } from '../../src/core/git.js';
import { computeDiff } from '../../src/core/diff-pipeline.js';
import { revertFile, revertLines, splitHunks } from '../../src/core/revert.js';

/** Real git: every case diffs the working tree the way the dashboard does
 *  (computeDiff vs HEAD), then reverts part of it. */

let root: string;
const write = (f: string, s: string) => {
  fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
  fs.writeFileSync(path.join(root, f), s);
};
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const exists = (f: string) => fs.existsSync(path.join(root, f));
const fileInDiff = (p: string) => computeDiff({ root, diffArg: 'HEAD' }).find((f) => f.path === p)!;
const lines = (n: number, tag = 'line') => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.email', 't@t.t'], root);
  git(['config', 'user.name', 'T'], root);
  git(['config', 'core.autocrlf', 'false'], root);
  write('a.txt', lines(40).join('\n') + '\n');
  write('crlf.txt', lines(5).join('\r\n') + '\r\n');
  write('gone.txt', 'keep me\n');
  write('old-name.txt', 'moved\n');
  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'init'], root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('revertLines', () => {
  it('undoes only the hunk that covers the picked lines', () => {
    const l = lines(40);
    l[2] = 'CHANGED top';
    l[35] = 'CHANGED bottom';
    write('a.txt', l.join('\n') + '\n');
    const f = fileInDiff('a.txt');
    expect(f.hunks).toHaveLength(2);
    const bottom = f.hunks[1];
    const out = revertLines(root, f, bottom.newStart, bottom.newStart + bottom.newLines - 1);
    expect(out).toMatchObject({ ok: true });
    expect(read('a.txt')).toContain('CHANGED top');
    expect(read('a.txt')).not.toContain('CHANGED bottom');
    expect(read('a.txt')).toContain('line 36');
  });

  it('leaves a whitespace-only change a few lines away alone (the diff hides it)', () => {
    const l = lines(40);
    l[9] = 'CHANGED'; // line 10: what you see and revert
    l[14] = '    line 15'; // line 15: indentation only, hidden by the -w diff (same raw hunk at 3 lines of context)
    write('a.txt', l.join('\n') + '\n');
    const f = fileInDiff('a.txt');
    expect(f.hunks).toHaveLength(1); // only line 10 is displayed
    const h = f.hunks[0];
    expect(revertLines(root, f, h.newStart, h.newStart + h.newLines - 1)).toMatchObject({ ok: true });
    expect(read('a.txt')).not.toContain('CHANGED');
    expect(read('a.txt')).toContain('    line 15'); // still there
  });

  it('reverts a hunk that only deletes lines', () => {
    const l = lines(40);
    l.splice(19, 2); // delete lines 20-21
    write('a.txt', l.join('\n') + '\n');
    const f = fileInDiff('a.txt');
    const h = f.hunks[0];
    expect(revertLines(root, f, h.newStart, h.newStart + Math.max(h.newLines, 1) - 1)).toMatchObject({ ok: true });
    expect(read('a.txt')).toBe(lines(40).join('\n') + '\n');
  });

  it('keeps CRLF line endings byte-exact', () => {
    write('crlf.txt', ['line 1', 'EDIT', 'line 3', 'line 4', 'line 5'].join('\r\n') + '\r\n');
    const f = fileInDiff('crlf.txt');
    const h = f.hunks[0];
    expect(revertLines(root, f, h.newStart, h.newStart + h.newLines - 1)).toMatchObject({ ok: true });
    expect(read('crlf.txt')).toBe(lines(5).join('\r\n') + '\r\n');
  });

  it('refuses when the file moved on since the diff was taken', () => {
    const l = lines(40);
    l[2] = 'CHANGED';
    write('a.txt', l.join('\n') + '\n');
    const f = fileInDiff('a.txt');
    write('a.txt', lines(40).join('\n') + '\n'); // someone already undid it
    const out = revertLines(root, f, 3, 3);
    expect(out).toMatchObject({ ok: false, status: 409 });
  });

  it('an untracked file is one hunk: reverting it removes the file', () => {
    write('new/untracked.ts', 'export {};\n');
    const f = fileInDiff('new/untracked.ts');
    expect(revertLines(root, f, 1, 1)).toMatchObject({ ok: true });
    expect(exists('new/untracked.ts')).toBe(false);
  });
});

describe('revertFile', () => {
  it('restores a modified file, staged changes included', () => {
    write('a.txt', 'rewritten\n');
    git(['add', 'a.txt'], root);
    write('a.txt', 'rewritten again\n');
    expect(revertFile(root, fileInDiff('a.txt'))).toMatchObject({ ok: true });
    expect(read('a.txt')).toBe(lines(40).join('\n') + '\n');
    expect(git(['status', '--porcelain'], root).stdout).toBe('');
  });

  it('brings back a deleted file', () => {
    fs.rmSync(path.join(root, 'gone.txt'));
    expect(revertFile(root, fileInDiff('gone.txt'))).toMatchObject({ ok: true });
    expect(read('gone.txt')).toBe('keep me\n');
  });

  it('removes a newly added (staged) file', () => {
    write('added.txt', 'hi\n');
    git(['add', 'added.txt'], root);
    expect(revertFile(root, fileInDiff('added.txt'))).toMatchObject({ ok: true });
    expect(exists('added.txt')).toBe(false);
    expect(git(['status', '--porcelain'], root).stdout).toBe('');
  });

  it('undoes a rename', () => {
    git(['mv', 'old-name.txt', 'new-name.txt'], root);
    const f = fileInDiff('new-name.txt');
    expect(f.status).toBe('renamed');
    expect(revertLines(root, f, 1, 1)).toMatchObject({ ok: false, status: 400 });
    expect(revertFile(root, f)).toMatchObject({ ok: true });
    expect(exists('new-name.txt')).toBe(false);
    expect(read('old-name.txt')).toBe('moved\n');
    expect(git(['status', '--porcelain'], root).stdout).toBe('');
  });

  it('refuses a path outside the worktree', () => {
    const f = { ...fileInDiff('gone.txt') ?? {}, path: '../escape.txt', oldPath: '../escape.txt', status: 'modified' } as never;
    expect(revertFile(root, f)).toMatchObject({ ok: false, status: 400 });
  });
});

describe('splitHunks', () => {
  it('splits a raw diff into its header and hunk ranges', () => {
    const raw = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,3 @@\n a\n+b\n c\n@@ -10 +11,0 @@\n-z\n';
    const { header, hunks } = splitHunks(raw);
    expect(header).toBe('diff --git a/x b/x\n--- a/x\n+++ b/x\n');
    expect(hunks.map((h) => [h.newStart, h.newEnd])).toEqual([[1, 3], [11, 11]]);
    expect(header + hunks.map((h) => h.text).join('')).toBe(raw);
  });
});
