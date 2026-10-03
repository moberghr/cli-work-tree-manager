import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../../../src/core/git/git.js';
import { buildFoldersOf, clearBuildFolders } from '../../../src/core/cleanup/build-folders.js';
import { BUILD_FOLDERS_IDLE_MS, createBuildFoldersJob, scanBuildFolders, type BuildFolderSession } from '../../../src/core/cleanup/build-folders-scan.js';

let tmp: string;
let repo: string;
let outside: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'build-folders-'));
  repo = path.join(tmp, 'repo');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(repo);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'must survive');
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 'T'], repo);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\napps/web/.next/\n');
  // A dist folder that is TRACKED (committed build output): never touched.
  fs.mkdirSync(path.join(repo, 'dist'));
  fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'tracked');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
  // Ignored build output, one of them nested.
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(1000));
  fs.mkdirSync(path.join(repo, 'apps', 'web', '.next'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'apps', 'web', '.next', 'build.js'), 'y'.repeat(500));
  // A link inside node_modules pointing outside (pnpm-style): the link goes, not its target.
  fs.symlinkSync(outside, path.join(repo, 'node_modules', 'linked'), 'junction');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('build folders', () => {
  it('finds and sizes only folders git ignores (not a tracked dist), without following links', async () => {
    const found = await buildFoldersOf(repo);
    expect(found.map((f) => path.relative(repo, f.path).replace(/\\/g, '/'))).toEqual(['node_modules', 'apps/web/.next']);
    expect(found[0].bytes).toBe(1000); // the linked folder's file isn't counted
    expect(found[1].bytes).toBe(500);
  });

  it("never enters a nested repo or worktree (its node_modules is someone else's)", async () => {
    const nested = path.join(repo, '.claude', 'worktrees', 'agent');
    fs.mkdirSync(path.join(nested, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.git'), 'gitdir: elsewhere\n'); // a worktree's .git is a file
    fs.writeFileSync(path.join(nested, 'node_modules', 'x', 'i.js'), 'z');
    const found = await buildFoldersOf(repo);
    expect(found.map((f) => path.relative(repo, f.path).replace(/\\/g, '/'))).toEqual(['node_modules', 'apps/web/.next']);
    await clearBuildFolders(repo);
    expect(fs.existsSync(path.join(nested, 'node_modules', 'x', 'i.js'))).toBe(true);
  });

  it('clears them, keeping tracked output and whatever a link points to', async () => {
    const r = await clearBuildFolders(repo);
    expect(r.removed).toHaveLength(2);
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'apps', 'web', '.next'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'dist', 'bundle.js'), 'utf8')).toBe('tracked');
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('must survive');
  });
});

describe('scanBuildFolders', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z');
  const s = (id: string, over: Partial<BuildFolderSession> = {}): BuildFolderSession => ({
    id, target: 'app', branch: id, paths: [repo], lastActiveMs: NOW - BUILD_FOLDERS_IDLE_MS - 1, running: false, ...over,
  });

  it('offers worktrees idle a week or more with no Claude running, biggest first', async () => {
    const list = await scanBuildFolders({
      sessions: async () => [s('idle'), s('recent', { lastActiveMs: NOW - 3_600_000 }), s('running', { running: true })],
      now: () => NOW,
    });
    expect(list.map((c) => c.sessionId)).toEqual(['idle']);
    expect(list[0].bytes).toBe(1500);
  });

  it('clearing refuses a session whose Claude is running now', async () => {
    const job = createBuildFoldersJob({ sessions: async () => [s('running', { running: true })], now: () => NOW });
    const [r] = await job.apply(['running']);
    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(true);
  });

  it('clearing checks the idle rule again: a session used this week is left alone', async () => {
    const job = createBuildFoldersJob({ sessions: async () => [s('recent', { lastActiveMs: NOW - 3_600_000 })], now: () => NOW });
    const [r] = await job.apply(['recent']);
    expect(r).toMatchObject({ ok: false, message: 'Used in the last week: left alone.' });
    expect(fs.existsSync(path.join(repo, 'node_modules'))).toBe(true);
  });
});
