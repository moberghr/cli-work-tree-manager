import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setupSharedCaches } from '../../src/core/symlinks.js';

let tmpDir: string;
let repoPath: string;
let worktreePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-symlinks-'));
  repoPath = path.join(tmpDir, 'repo');
  worktreePath = path.join(tmpDir, 'worktree');
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  // Silence console output during tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('setupSharedCaches', () => {
  it('creates symlinks for existing source dirs', () => {
    fs.mkdirSync(path.join(repoPath, 'node_modules'));
    fs.writeFileSync(path.join(repoPath, 'node_modules', 'marker.txt'), 'hi');

    setupSharedCaches(repoPath, worktreePath, ['node_modules']);

    const dest = path.join(worktreePath, 'node_modules');
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);
    // Symlink resolves to the source content
    expect(
      fs.readFileSync(path.join(dest, 'marker.txt'), 'utf-8'),
    ).toBe('hi');
  });

  it('handles multiple names', () => {
    fs.mkdirSync(path.join(repoPath, 'node_modules'));
    fs.mkdirSync(path.join(repoPath, '.venv'));

    setupSharedCaches(repoPath, worktreePath, ['node_modules', '.venv']);

    expect(
      fs.lstatSync(path.join(worktreePath, 'node_modules')).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(worktreePath, '.venv')).isSymbolicLink(),
    ).toBe(true);
  });

  it('skips when destination already exists', () => {
    fs.mkdirSync(path.join(repoPath, 'node_modules'));
    // Pre-existing real directory at dest must be preserved.
    const dest = path.join(worktreePath, 'node_modules');
    fs.mkdirSync(dest);
    fs.writeFileSync(path.join(dest, 'existing.txt'), 'keep');

    setupSharedCaches(repoPath, worktreePath, ['node_modules']);

    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(dest, 'existing.txt'))).toBe(true);
  });

  it('skips when source does not exist', () => {
    setupSharedCaches(repoPath, worktreePath, ['node_modules']);
    expect(fs.existsSync(path.join(worktreePath, 'node_modules'))).toBe(false);
  });

  it('does not throw when symlink fails (dest is an existing file blocking is handled, force a real failure)', () => {
    fs.mkdirSync(path.join(repoPath, 'node_modules'));
    // Make the symlink call itself fail by stubbing it to throw.
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation(() => {
      throw new Error('EPERM: simulated');
    });

    expect(() =>
      setupSharedCaches(repoPath, worktreePath, ['node_modules']),
    ).not.toThrow();

    spy.mockRestore();
  });

  it('does not throw and skips when dest is an existing file', () => {
    fs.mkdirSync(path.join(repoPath, 'node_modules'));
    // A plain file at the destination path.
    fs.writeFileSync(path.join(worktreePath, 'node_modules'), 'i am a file');

    expect(() =>
      setupSharedCaches(repoPath, worktreePath, ['node_modules']),
    ).not.toThrow();
    // Still a file, not a symlink.
    expect(
      fs.lstatSync(path.join(worktreePath, 'node_modules')).isFile(),
    ).toBe(true);
  });
});
