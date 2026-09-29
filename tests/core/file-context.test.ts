import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { isSafeRef, readContextLines } from '../../src/core/file-context.js';

let tmpDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-fc-test-'));
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir);
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.email t@t.t', { cwd: repoDir });
  execSync('git config user.name t', { cwd: repoDir });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, body: string) {
  fs.writeFileSync(path.join(repoDir, rel), body);
}

describe('readContextLines (working tree)', () => {
  it('returns the requested inclusive 1-based slice', () => {
    write('f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    const r = readContextLines({ root: repoDir, relPath: 'f.txt', start: 2, end: 4 });
    expect(r).not.toBeNull();
    expect(r!.lines).toEqual(['l2', 'l3', 'l4']);
    expect(r!.start).toBe(2);
    expect(r!.totalLines).toBe(5);
    expect(r!.eof).toBe(false);
  });

  it('clamps the slice at EOF and flags eof', () => {
    write('f.txt', 'l1\nl2\nl3\n');
    const r = readContextLines({ root: repoDir, relPath: 'f.txt', start: 2, end: 10 });
    expect(r!.lines).toEqual(['l2', 'l3']);
    expect(r!.eof).toBe(true);
    expect(r!.totalLines).toBe(3);
  });

  it('counts a file with no trailing newline correctly', () => {
    write('f.txt', 'l1\nl2\nl3');
    const r = readContextLines({ root: repoDir, relPath: 'f.txt', start: 1, end: 3 });
    expect(r!.lines).toEqual(['l1', 'l2', 'l3']);
    expect(r!.totalLines).toBe(3);
    expect(r!.eof).toBe(true);
  });

  it('returns an empty slice when start is past EOF', () => {
    write('f.txt', 'l1\nl2\n');
    const r = readContextLines({ root: repoDir, relPath: 'f.txt', start: 5, end: 9 });
    expect(r!.lines).toEqual([]);
    expect(r!.eof).toBe(true);
  });

  it('rejects a path that escapes the repo root', () => {
    expect(
      readContextLines({ root: repoDir, relPath: '../outside.txt', start: 1, end: 1 }),
    ).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(
      readContextLines({ root: repoDir, relPath: 'nope.txt', start: 1, end: 1 }),
    ).toBeNull();
  });
});

describe('readContextLines (git ref)', () => {
  it('reads committed content via git show', () => {
    write('f.txt', 'a\nb\nc\n');
    execSync('git add . && git commit -q -m init', { cwd: repoDir });
    // Mutate the working tree — the ref read must see the committed version.
    write('f.txt', 'X\nY\nZ\n');
    const r = readContextLines({
      root: repoDir,
      relPath: 'f.txt',
      start: 1,
      end: 3,
      ref: 'HEAD',
    });
    expect(r!.lines).toEqual(['a', 'b', 'c']);
  });

  it('returns null for an unknown ref', () => {
    write('f.txt', 'a\n');
    execSync('git add . && git commit -q -m init', { cwd: repoDir });
    expect(
      readContextLines({
        root: repoDir,
        relPath: 'f.txt',
        start: 1,
        end: 1,
        ref: 'deadbeef',
      }),
    ).toBeNull();
  });
});

describe('the ref comes from a query string', () => {
  it('cannot smuggle a git option in: --output=<file> writes nothing', () => {
    write('f.txt', 'a\nb\n');
    execSync('git add . && git commit -q -m init', { cwd: repoDir });
    const target = path.join(tmpDir, 'pwned');
    for (const ref of [`--output=${target}`, '-O/etc/passwd', '--help']) {
      expect(readContextLines({ root: repoDir, relPath: 'f.txt', start: 1, end: 2, ref })).toBeNull();
    }
    expect(fs.existsSync(`${target}:f.txt`)).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('still reads real refs: HEAD, a sha, a branch, HEAD~0', () => {
    write('f.txt', 'a\nb\n');
    execSync('git add . && git commit -q -m init', { cwd: repoDir });
    const sha = execSync('git rev-parse HEAD', { cwd: repoDir }).toString().trim();
    const branch = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
    for (const ref of ['HEAD', sha, sha.slice(0, 7), branch, 'HEAD~0']) {
      expect(readContextLines({ root: repoDir, relPath: 'f.txt', start: 1, end: 2, ref })?.lines).toEqual(['a', 'b']);
    }
  });
});

describe('isSafeRef', () => {
  it('accepts what refs look like and nothing that git would read as an option', () => {
    for (const ok of ['HEAD', 'main', 'feat/x-1', 'abc1234', 'HEAD~2', 'HEAD^', 'origin/main', 'v1.2.3', 'main@{1}']) {
      expect(isSafeRef(ok), ok).toBe(true);
    }
    for (const bad of ['--output=/tmp/x', '-O/etc/passwd', '-p', '', 'a..b', 'x y', 'x;rm', '$(id)', 'a\nb']) {
      expect(isSafeRef(bad), bad).toBe(false);
    }
  });
});
