import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import spawn from 'cross-spawn';
import { git } from '../../src/core/git.js';
import { inRepoQueue, writeTempTree, writeTempTreeAsync } from '../../src/core/git-tree-snapshot.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-snap-'));
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 't@t.t'], repo);
  git(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'kept.md'), '# kept\n');
  fs.writeFileSync(path.join(repo, 'edited.md'), 'before\n');
  fs.writeFileSync(path.join(repo, 'removed.md'), 'doomed\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.txt\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repo);
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

/**
 * The tree the old implementation produced: a throwaway index built by
 * `read-tree HEAD` (no stat cache), then `add -A`. `writeTempTree` now seeds
 * from the repo's real index instead, purely for its stat cache — these two
 * must agree on the resulting tree, or the speedup would be silently changing
 * what a checkpoint captures.
 */
function treeViaReadTree(repoRoot: string): string {
  const tmpIndex = path.join(
    os.tmpdir(),
    `wd-test-${crypto.randomBytes(6).toString('hex')}.idx`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const run = (args: string[]) =>
    spawn.sync('git', args, { cwd: repoRoot, encoding: 'utf-8', env });
  try {
    run(['read-tree', 'HEAD']);
    run(['add', '-A']);
    return (run(['write-tree']).stdout ?? '').trim();
  } finally {
    if (fs.existsSync(tmpIndex)) fs.unlinkSync(tmpIndex);
  }
}

describe('writeTempTree', () => {
  it('captures a clean working tree as HEAD s tree', () => {
    const result = writeTempTree(repo);
    expect(result).not.toBeNull();
    expect(result!.treeSha).toBe(treeViaReadTree(repo));
  });

  it('matches the read-tree path across edits, adds, deletes and staged changes', () => {
    // One of each kind of working-tree state, including a staged edit — the
    // copied index starts with staged content, and `add -A` must overwrite it
    // with what is actually on disk.
    fs.writeFileSync(path.join(repo, 'edited.md'), 'after\n');
    fs.writeFileSync(path.join(repo, 'untracked.md'), 'new\n');
    fs.writeFileSync(path.join(repo, 'ignored.txt'), 'invisible\n');
    fs.rmSync(path.join(repo, 'removed.md'));
    fs.writeFileSync(path.join(repo, 'staged.md'), 'staged then edited\n');
    git(['add', 'staged.md'], repo);
    fs.writeFileSync(path.join(repo, 'staged.md'), 'edited after staging\n');

    const result = writeTempTree(repo);
    expect(result).not.toBeNull();
    expect(result!.treeSha).toBe(treeViaReadTree(repo));

    // Spot-check the content rather than trusting sha equality alone.
    const listed = spawn.sync(
      'git',
      ['ls-tree', '-r', '--name-only', result!.treeSha],
      { cwd: repo, encoding: 'utf-8' },
    ).stdout;
    expect(listed).toContain('untracked.md');
    expect(listed).not.toContain('removed.md');
    expect(listed).not.toContain('ignored.txt');
  });

  it.each([
    ['assume-unchanged', '--assume-unchanged'],
    ['skip-worktree', '--skip-worktree'],
  ])('still captures edits to a %s file', (_name, flag) => {
    // The copied index carries these bits, and `add -A` trusts them and never
    // re-reads the file — the old read-tree index had no such bits, so edits
    // to e.g. a locally-tweaked config file were captured. Seeding must not
    // silently drop them from checkpoints and range diffs.
    git(['update-index', flag, 'kept.md'], repo);
    fs.writeFileSync(path.join(repo, 'kept.md'), '# locally tweaked\n');

    const result = writeTempTree(repo);
    expect(result).not.toBeNull();
    const blob = spawn.sync('git', ['show', `${result!.treeSha}:kept.md`], {
      cwd: repo,
      encoding: 'utf-8',
    }).stdout;
    expect(blob).toBe('# locally tweaked\n');
  });

  it('re-hashes racily-clean entries (the copy keeps the real index mtime)', () => {
    // Git re-hashes an entry whose file mtime is >= the index file's own
    // mtime ("racily clean") instead of trusting its cached stat. Copying the
    // index stamps the copy with "now", which would make such entries look
    // safely clean — and a same-size edit in the same tick would be missed.
    // Built deterministically with utimes instead of racing the clock.
    // checkStat=minimal + trustctime=false make the stat cache compare only
    // mtime seconds + size, so nothing else gives the edit away.
    git(['config', 'core.checkStat', 'minimal'], repo);
    git(['config', 'core.trustctime', 'false'], repo);
    const file = path.join(repo, 'racy.md');
    const past = new Date(Date.now() - 100_000);
    fs.writeFileSync(file, 'aaaa\n');
    fs.utimesSync(file, past, past);
    // Staged while NOT racy (index written now, file dated in the past), so
    // git records a clean, un-smudged entry: mtime=past, size=5.
    git(['add', 'racy.md'], repo);

    // Same-size edit, stat forged back to exactly what the index cached...
    fs.writeFileSync(file, 'bbbb\n');
    fs.utimesSync(file, past, past);
    // ...and the real index dated to the same instant: the entry is now
    // racily clean, so only a content re-hash can notice the edit.
    const realIndex = path.join(repo, '.git', 'index');
    fs.utimesSync(realIndex, past, past);

    const result = writeTempTree(repo);
    expect(result).not.toBeNull();
    const blob = spawn.sync('git', ['show', `${result!.treeSha}:racy.md`], {
      cwd: repo,
      encoding: 'utf-8',
    }).stdout;
    expect(blob).toBe('bbbb\n');
  });

  it('leaves the real index untouched', () => {
    fs.writeFileSync(path.join(repo, 'untracked.md'), 'new\n');
    const before = fs.readFileSync(path.join(repo, '.git', 'index'));
    writeTempTree(repo);
    expect(fs.readFileSync(path.join(repo, '.git', 'index')).equals(before)).toBe(
      true,
    );
    // Still untracked as far as the user's git is concerned.
    const status = git(['status', '--porcelain'], repo).stdout;
    expect(status).toContain('?? untracked.md');
  });

  it('captures HEAD verbatim when includeWorkingTree is false', () => {
    fs.writeFileSync(path.join(repo, 'edited.md'), 'after\n');
    fs.writeFileSync(path.join(repo, 'untracked.md'), 'new\n');
    const result = writeTempTree(repo, { includeWorkingTree: false });
    expect(result).not.toBeNull();
    const headTree = git(['rev-parse', 'HEAD^{tree}'], repo).stdout.trim();
    expect(result!.treeSha).toBe(headTree);
  });

  it('works in a repo with no commits yet (nothing to seed from)', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'work-tree-fresh-'));
    try {
      git(['init', '-b', 'main'], fresh);
      git(['config', 'user.email', 't@t.t'], fresh);
      git(['config', 'user.name', 'Test'], fresh);
      fs.writeFileSync(path.join(fresh, 'only.md'), 'hi\n');
      const result = writeTempTree(fresh);
      expect(result).not.toBeNull();
      expect(result!.headSha).toBeNull();
      const listed = spawn.sync(
        'git',
        ['ls-tree', '-r', '--name-only', result!.treeSha],
        { cwd: fresh, encoding: 'utf-8' },
      ).stdout;
      expect(listed).toContain('only.md');
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('writeTempTreeAsync (checkpoints)', () => {
  it('builds the same tree as the synchronous version, without blocking the event loop', async () => {
    fs.writeFileSync(path.join(repo, 'edited.md'), 'after\n');
    fs.writeFileSync(path.join(repo, 'new.md'), 'untracked\n');
    fs.rmSync(path.join(repo, 'removed.md'));
    const sync = writeTempTree(repo);
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 1);
    const async = await writeTempTreeAsync(repo);
    clearInterval(ticker);
    expect(async).toEqual(sync);
    expect(ticks).toBeGreaterThan(0); // timers ran while git did
    expect(await writeTempTreeAsync(repo, { includeWorkingTree: false })).toEqual(writeTempTree(repo, { includeWorkingTree: false }));
  });

  it('null for a folder that is not a repo', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      expect(await writeTempTreeAsync(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('inRepoQueue', () => {
  it('runs one job per repo at a time, in order; other repos run alongside; a failure does not stop the queue', async () => {
    const log: string[] = [];
    const job = (name: string, ms: number, fail = false) => async () => {
      log.push(`${name}+`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${name}-`);
      if (fail) throw new Error(name);
      return name;
    };
    const a1 = inRepoQueue('/r/a', job('a1', 30, true));
    const a2 = inRepoQueue('/R/A', job('a2', 5)); // same repo, other case
    const b1 = inRepoQueue('/r/b', job('b1', 5));
    await expect(a1).rejects.toThrow('a1');
    expect(await a2).toBe('a2');
    expect(await b1).toBe('b1');
    expect(log.indexOf('a1-')).toBeLessThan(log.indexOf('a2+'));
    expect(log.indexOf('b1+')).toBeLessThan(log.indexOf('a1-'));
  });
});
