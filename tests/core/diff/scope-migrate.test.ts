import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../../src/core/git/git.js';
import { loadManifest, manifestPath, takeCheckpoint, type ScopeRepo } from '../../../src/core/diff/checkpoint.js';
import { commentStoreIdForScope, scopeHashForPaths } from '../../../src/core/diff/scope-manager.js';
import { migrateScope } from '../../../src/core/diff/scope-migrate.js';
import { getCommentFileStore, readStoreComments, clearCommentStoreCache } from '../../../src/core/comments/comment-file-store.js';
import { parsePoint, rangeRefs } from '../../../src/core/diff/diff-points.js';

/**
 * A session's turn history moves with its paths (a repo added): the
 * manifest, the refs in every repo and the scope's comments go to the new
 * scope hash, so the Diff tab still lists the old turns.
 */

let template: string;
let home: string;
let A: string;
let B: string;
let C: string;

beforeAll(() => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-migrate-template-'));
  for (const name of ['repoA', 'repoB', 'repoC']) {
    const r = path.join(template, name);
    fs.mkdirSync(r);
    git(['init', '-q', '-b', 'main'], r);
    fs.writeFileSync(path.join(r, 'README.md'), `# ${name}\n`);
    git(['add', '.'], r);
    git(['commit', '-q', '-m', 'init', '--no-gpg-sign'], r);
  }
}, 60_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-migrate-')));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  for (const name of ['repoA', 'repoB', 'repoC']) fs.cpSync(path.join(template, name), path.join(home, name), { recursive: true });
  [A, B, C] = ['repoA', 'repoB', 'repoC'].map((n) => path.join(home, n));
  clearCommentStoreCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearCommentStoreCache();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const repos = (...roots: string[]): ScopeRepo[] => roots.map((root) => ({ name: path.basename(root), root }));
const refs = (repo: string, hash: string) =>
  git(['for-each-ref', '--format=%(refname)', `refs/wd/${hash}/`], repo)
    .stdout.split('\n')
    .filter(Boolean)
    .sort();

/** Two turns of a session over [A, B], and a comment on its scope's page. */
async function sessionWithTurns(): Promise<{ oldHash: string }> {
  const oldHash = scopeHashForPaths([A, B]);
  await takeCheckpoint(oldHash, repos(A, B)); // Initial
  fs.writeFileSync(path.join(A, 'a.txt'), 'turn 1\n');
  await takeCheckpoint(oldHash, repos(A, B));
  fs.writeFileSync(path.join(B, 'b.txt'), 'turn 2\n');
  await takeCheckpoint(oldHash, repos(A, B));
  getCommentFileStore(commentStoreIdForScope(oldHash)).post({ side: 'general', status: 'published', author: 'user', body: 'keep this' });
  return { oldHash };
}

describe('migrateScope', () => {
  it('moves the manifest, the refs in every repo and the comments to the new hash', async () => {
    const { oldHash } = await sessionWithTurns();
    const newHash = scopeHashForPaths([A, B, C]);
    const before = loadManifest(oldHash).entries;
    expect(before.map((e) => e.id)).toEqual([0, 1, 2]);

    const r = migrateScope([A, B], [A, B, C]);
    expect(r).toMatchObject({ from: oldHash, to: newHash, manifest: true, refs: 6, comments: 1 });

    // The manifest: under the new hash, with the same turns; the old file gone.
    expect(fs.existsSync(manifestPath(oldHash))).toBe(false);
    const moved = loadManifest(newHash);
    expect(moved.entries).toEqual(before);
    expect((JSON.parse(fs.readFileSync(manifestPath(newHash), 'utf8')) as { scopeHash: string }).scopeHash).toBe(newHash);
    // The refs: in each old repo, old gone and new there, at the same commits.
    for (const repo of [A, B]) {
      expect(refs(repo, oldHash)).toEqual([]);
      expect(refs(repo, newHash)).toEqual([0, 1, 2].map((id) => `refs/wd/${newHash}/${id}`));
      for (const e of before) expect(git(['rev-parse', `refs/wd/${newHash}/${e.id}`], repo).stdout).toBe(e.repos[path.basename(repo)]);
    }
    // The comments: in the new store, none left in the old.
    expect(readStoreComments(commentStoreIdForScope(oldHash))).toEqual([]);
    expect(readStoreComments(commentStoreIdForScope(newHash)).map((c) => c.body)).toEqual(['keep this']);
  }, 60_000);

  it('is idempotent: a second run moves nothing and loses nothing', async () => {
    await sessionWithTurns();
    const newHash = scopeHashForPaths([A, B, C]);
    migrateScope([A, B], [A, B, C]);
    const again = migrateScope([A, B], [A, B, C]);
    expect(again).toMatchObject({ manifest: false, refs: 0, comments: 0 });
    expect(loadManifest(newHash).entries.map((e) => e.id)).toEqual([0, 1, 2]);
    expect(refs(A, newHash)).toHaveLength(3);
    expect(readStoreComments(commentStoreIdForScope(newHash))).toHaveLength(1);
  }, 60_000);

  it('is a no-op when the old scope has nothing', () => {
    const r = migrateScope([A, B], [A, B, C]);
    expect(r).toMatchObject({ manifest: false, refs: 0, comments: 0 });
    expect(fs.existsSync(manifestPath(scopeHashForPaths([A, B, C])))).toBe(false);
    expect(refs(A, scopeHashForPaths([A, B, C]))).toEqual([]);
  });

  it('a path that is gone is skipped, the rest moved', async () => {
    const { oldHash } = await sessionWithTurns();
    fs.rmSync(B, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    const r = migrateScope([A, B], [A, B, C]);
    expect(r).toMatchObject({ manifest: true, refs: 3 });
    expect(refs(A, oldHash)).toEqual([]);
  }, 60_000);

  it('the same paths: nothing to do', async () => {
    await sessionWithTurns();
    expect(migrateScope([A, B], [B, A])).toMatchObject({ manifest: false, refs: 0, comments: 0 });
  }, 60_000);
});

describe('after migration', () => {
  it('the session lists its old turns, and the next checkpoint includes the new repo', async () => {
    await sessionWithTurns();
    migrateScope([A, B], [A, B, C]);
    // As GET …/checkpoints reads it: by the hash of the session's paths now.
    const newHash = scopeHashForPaths([A, B, C]);
    expect(loadManifest(newHash).entries.map((e) => e.id)).toEqual([0, 1, 2]);

    fs.writeFileSync(path.join(C, 'c.txt'), 'turn 3\n');
    const entry = await takeCheckpoint(newHash, repos(A, B, C));
    expect(entry?.id).toBe(3);
    expect(entry?.repos.repoC).toMatch(/^[0-9a-f]{40}$/);
    expect(refs(C, newHash)).toEqual([`refs/wd/${newHash}/3`]);

    // An old turn has no snapshot of the new repo: a range reads its HEAD there.
    const all = loadManifest(newHash).entries;
    const range = rangeRefs([A, B, C], all, parsePoint('cp:1')!, parsePoint('cp:3')!);
    expect(Array.isArray(range)).toBe(true);
    const c = (range as Array<{ name: string; fromRef: string; toRef: string }>).find((x) => x.name === 'repoC')!;
    expect(c.fromRef).toBe('HEAD');
    expect(c.toRef).toBe(entry!.repos.repoC);
  }, 60_000);
});
