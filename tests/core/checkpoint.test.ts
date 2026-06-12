import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { git } from '../../src/core/git.js';
import {
  takeCheckpoint,
  updateCheckpoint,
  loadManifest,
  snapshotRepo,
  clearCheckpoints,
  manifestPath,
} from '../../src/core/checkpoint.js';

let tmpHome: string;
let repoA: string;
let repoB: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'work-cp-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

  // Two real repos so we can exercise group scenarios.
  repoA = path.join(tmpHome, 'repoA');
  repoB = path.join(tmpHome, 'repoB');
  fs.mkdirSync(repoA);
  fs.mkdirSync(repoB);
  for (const r of [repoA, repoB]) {
    git(['init', '-b', 'main'], r);
    git(['config', 'user.email', 't@t.t'], r);
    git(['config', 'user.name', 'Test'], r);
    fs.writeFileSync(path.join(r, 'README.md'), '# initial\n');
    git(['add', '.'], r);
    git(['commit', '-m', 'init', '--no-gpg-sign'], r);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function writeFile(repo: string, rel: string, content: string) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('snapshotRepo', () => {
  it('captures the working tree as a commit reachable via refs/wd/<hash>/<id>', () => {
    writeFile(repoA, 'README.md', '# changed\n');
    writeFile(repoA, 'untracked.txt', 'new content\n');

    const sha = snapshotRepo(repoA, 'abc123', 7);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // Ref exists.
    const refSha = git(['rev-parse', 'refs/wd/abc123/7'], repoA).stdout.trim();
    expect(refSha).toBe(sha);

    // The snapshot's tree contains the untracked file.
    const ls = git(['ls-tree', '-r', sha!], repoA);
    expect(ls.stdout).toContain('untracked.txt');
    expect(ls.stdout).toContain('README.md');
  });

  it('honours .gitignore (does not snapshot ignored files)', () => {
    writeFile(repoA, '.gitignore', 'secret.txt\n');
    git(['add', '.'], repoA);
    git(['commit', '-m', 'gi', '--no-gpg-sign'], repoA);
    writeFile(repoA, 'secret.txt', 'shh');

    const sha = snapshotRepo(repoA, 'h', 0);
    const ls = git(['ls-tree', '-r', sha!], repoA);
    expect(ls.stdout).not.toContain('secret.txt');
  });

  it('does not touch the real index', () => {
    writeFile(repoA, 'staged.txt', 'staged\n');
    git(['add', 'staged.txt'], repoA);
    writeFile(repoA, 'unstaged.txt', 'unstaged\n');

    snapshotRepo(repoA, 'h', 0);

    // staged.txt is still the only file in the index.
    const status = git(['status', '--porcelain'], repoA).stdout;
    expect(status).toContain('A  staged.txt');
    expect(status).toContain('?? unstaged.txt');
  });
});

describe('takeCheckpoint', () => {
  it('records id 0 with label "Initial" on first capture', async () => {
    const entry = await takeCheckpoint('hashA', [
      { name: 'repoA', root: repoA },
    ]);
    expect(entry).not.toBeNull();
    expect(entry!.id).toBe(0);
    expect(entry!.label).toBe('Initial');
    expect(entry!.repos.repoA).toMatch(/^[0-9a-f]{40}$/);
  });

  it('persists to ~/.work/diffs/<hash>.checkpoints.json', async () => {
    await takeCheckpoint('hashA', [{ name: 'repoA', root: repoA }]);
    const manifest = loadManifest('hashA');
    expect(manifest.entries).toHaveLength(1);
    expect(fs.existsSync(manifestPath('hashA'))).toBe(true);
  });

  it('skips when nothing changed (dedup) and returns null', async () => {
    const first = await takeCheckpoint('hashA', [
      { name: 'repoA', root: repoA },
    ]);
    expect(first).not.toBeNull();

    // No working-tree changes between calls.
    const second = await takeCheckpoint('hashA', [
      { name: 'repoA', root: repoA },
    ]);
    expect(second).toBeNull();

    // Manifest stays at 1 entry; the rolled-back ref is gone.
    const manifest = loadManifest('hashA');
    expect(manifest.entries).toHaveLength(1);
    const orphan = git(
      ['rev-parse', '--verify', '--quiet', 'refs/wd/hashA/1'],
      repoA,
    );
    expect(orphan.exitCode).not.toBe(0);
  });

  it('initial checkpoint baselines HEAD, not the working tree (pre-existing changes stay visible)', async () => {
    // Pre-existing uncommitted work present at the moment the scope is
    // registered (`wd` launched on a dirty worktree). If the Initial
    // checkpoint snapshotted the working tree, these changes would be
    // baked into the baseline and vanish from the default "Initial →
    // working" range. The baseline must be HEAD instead.
    writeFile(repoA, 'README.md', '# pre-existing change\n');
    writeFile(repoA, 'new.txt', 'untracked\n');

    const initial = await takeCheckpoint('baseline', [
      { name: 'repoA', root: repoA },
    ]);
    expect(initial).not.toBeNull();
    expect(initial!.label).toBe('Initial');

    // The Initial snapshot's tree must equal HEAD's tree — the working-
    // tree changes are NOT folded into the baseline.
    const headTree = git(['rev-parse', 'HEAD^{tree}'], repoA).stdout.trim();
    const initialTree = git(
      ['rev-parse', `${initial!.repos.repoA}^{tree}`],
      repoA,
    ).stdout.trim();
    expect(initialTree).toBe(headTree);
  });

  it('dedups by TREE sha, not commit sha — drops a snapshot whose content is identical even when HEAD moved', async () => {
    // Initial baseline (id 0 = HEAD's tree).
    await takeCheckpoint('treededup', [{ name: 'repoA', root: repoA }]);

    // Stage uncommitted content (modified + untracked) and capture it as
    // id 1 — a working-tree snapshot whose tree is broader than HEAD's.
    writeFile(repoA, 'extra.md', '# untracked\n');
    writeFile(repoA, 'README.md', '# modified\n');
    const second = await takeCheckpoint('treededup', [
      { name: 'repoA', root: repoA },
    ]);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(1);

    // User commits the entire working tree. HEAD moves; working-tree
    // content is unchanged. The next snapshot has the SAME tree as
    // id 1 but a different parent (so different commit sha). Commit-sha
    // dedup would miss this; tree-sha dedup correctly drops it.
    git(['add', '.'], repoA);
    git(['commit', '-m', 'commit-working-tree', '--no-gpg-sign'], repoA);

    const third = await takeCheckpoint('treededup', [
      { name: 'repoA', root: repoA },
    ]);
    expect(third).toBeNull();

    const manifest = loadManifest('treededup');
    expect(manifest.entries).toHaveLength(2);
  });

  it('appends a new entry when the working tree changed', async () => {
    await takeCheckpoint('hashA', [{ name: 'repoA', root: repoA }]);
    writeFile(repoA, 'README.md', '# v2\n');
    const next = await takeCheckpoint('hashA', [
      { name: 'repoA', root: repoA },
    ]);
    expect(next).not.toBeNull();
    expect(next!.id).toBe(1);

    const manifest = loadManifest('hashA');
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries[0].id).toBe(0);
    expect(manifest.entries[1].id).toBe(1);
    expect(manifest.entries[0].repos.repoA).not.toBe(
      manifest.entries[1].repos.repoA,
    );
  });

  it('bails (returns null, no manifest entry) when any repo snapshot fails', async () => {
    // Build a "repo" pointing at a non-git directory so snapshotRepo
    // fails (read-tree errors out on a non-existent HEAD when the dir
    // isn't a git working tree). The healthy repoA should still be
    // captured to its ref, but the entry must NOT be written — a
    // partial entry would let diffs against this id silently 'HEAD'
    // for the broken repo.
    const broken = path.join(tmpHome, 'not-a-repo');
    fs.mkdirSync(broken);

    await takeCheckpoint('hashFail', [{ name: 'repoA', root: repoA }]);
    writeFile(repoA, 'README.md', '# changed\n');

    const result = await takeCheckpoint('hashFail', [
      { name: 'repoA', root: repoA },
      { name: 'broken', root: broken },
    ]);
    expect(result).toBeNull();

    const manifest = loadManifest('hashFail');
    expect(manifest.entries).toHaveLength(1); // Only the initial.
  });

  it('snapshots all repos in a group scope at once', async () => {
    // Commit distinct content into each repo so their HEAD baselines
    // differ. The Initial checkpoint captures HEAD (not the working
    // tree), and both repos start from an identical committed README in
    // beforeEach — so without distinct HEADs their baseline commits
    // would (correctly) be identical and the distinctness check below
    // would be meaningless.
    writeFile(repoA, 'a.md', 'A1\n');
    writeFile(repoB, 'b.md', 'B1\n');
    git(['add', '.'], repoA);
    git(['commit', '-m', 'a', '--no-gpg-sign'], repoA);
    git(['add', '.'], repoB);
    git(['commit', '-m', 'b', '--no-gpg-sign'], repoB);
    const entry = await takeCheckpoint('hashG', [
      { name: 'repoA', root: repoA },
      { name: 'repoB', root: repoB },
    ]);
    expect(entry).not.toBeNull();
    expect(entry!.repos.repoA).toMatch(/^[0-9a-f]{40}$/);
    expect(entry!.repos.repoB).toMatch(/^[0-9a-f]{40}$/);
    expect(entry!.repos.repoA).not.toBe(entry!.repos.repoB);
  });

  it('serialises concurrent calls — no duplicate ids', async () => {
    // Two concurrent fs-watch fires used to read the manifest before
    // acquiring the lock, both compute the same nextId, both append.
    // The fix wraps the whole flow in withFileLock; this test catches
    // a regression by running 5 captures in parallel against the same
    // scope and asserting strictly increasing, unique ids.
    await takeCheckpoint('hashP', [{ name: 'repoA', root: repoA }]);

    const results = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        // Each call needs to find a DIFFERENT working tree, otherwise
        // dedup kicks in and they all skip. Sequential file mutations
        // before kicking off the captures.
        writeFile(repoA, `f${i}.md`, `content ${i}\n`);
        return takeCheckpoint('hashP', [{ name: 'repoA', root: repoA }]);
      }),
    );

    const ids = results.filter(Boolean).map((e) => e!.id);
    expect(new Set(ids).size).toBe(ids.length); // No duplicates.
    const manifest = loadManifest('hashP');
    const sorted = [...manifest.entries].sort((a, b) => a.id - b.id);
    sorted.forEach((entry, i) => expect(entry.id).toBe(i));
  });

  it('keeps SHAs distinct when repos share a basename (no manifest key collision)', async () => {
    // Two repos with the same basename ("app"). If the manifest key
    // were `path.basename(root)`, the second snapshot would overwrite
    // the first in `captured`, silently corrupting one repo's diff
    // baseline. The route now keys by full path; verify the underlying
    // module respects whatever `name` the caller supplies and keeps
    // them distinct even when basenames collide.
    const left = path.join(tmpHome, 'parentA', 'app');
    const right = path.join(tmpHome, 'parentB', 'app');
    fs.mkdirSync(left, { recursive: true });
    fs.mkdirSync(right, { recursive: true });
    for (const r of [left, right]) {
      git(['init', '-b', 'main'], r);
      git(['config', 'user.email', 't@t.t'], r);
      git(['config', 'user.name', 'Test'], r);
      fs.writeFileSync(
        path.join(r, 'README.md'),
        `# ${path.basename(path.dirname(r))}\n`,
      );
      git(['add', '.'], r);
      git(['commit', '-m', 'init', '--no-gpg-sign'], r);
    }

    const repos = [
      { name: left, root: left },
      { name: right, root: right },
    ];

    const first = await takeCheckpoint('collision', repos);
    expect(first).not.toBeNull();
    expect(Object.keys(first!.repos).sort()).toEqual([left, right].sort());
    expect(first!.repos[left]).not.toBe(first!.repos[right]);

    fs.writeFileSync(path.join(left, 'README.md'), '# left v2\n');
    const second = await takeCheckpoint('collision', repos);
    expect(second).not.toBeNull();
    // Left changed → new sha. Right unchanged → identical sha.
    expect(second!.repos[left]).not.toBe(first!.repos[left]);
    expect(second!.repos[right]).toBe(first!.repos[right]);
  });

  it('dedup is per-scope — a different scopeHash creates a fresh entry', async () => {
    await takeCheckpoint('s1', [{ name: 'repoA', root: repoA }]);
    const entry2 = await takeCheckpoint('s2', [
      { name: 'repoA', root: repoA },
    ]);
    expect(entry2).not.toBeNull();
    expect(entry2!.id).toBe(0); // Fresh manifest for s2.
  });
});

describe('updateCheckpoint (per-instruction live step refresh)', () => {
  it('refreshes an existing entry in place when content changed (no new id)', async () => {
    await takeCheckpoint('hashU', [{ name: 'repoA', root: repoA }]); // #0
    writeFile(repoA, 'work.txt', 'turn 1\n');
    const live = await takeCheckpoint('hashU', [{ name: 'repoA', root: repoA }]);
    expect(live!.id).toBe(1);
    const shaAfterTurn1 = live!.repos.repoA;

    // Same instruction, next turn: more changes refresh the SAME step.
    writeFile(repoA, 'work.txt', 'turn 1\nturn 2\n');
    const res = await updateCheckpoint('hashU', [{ name: 'repoA', root: repoA }], 1);
    expect(res.status).toBe('updated');
    if (res.status !== 'updated') throw new Error('unreachable');
    expect(res.entry.id).toBe(1);
    expect(res.entry.repos.repoA).not.toBe(shaAfterTurn1);

    // Still exactly two entries — no per-turn proliferation.
    const manifest = loadManifest('hashU');
    expect(manifest.entries).toHaveLength(2);
    // The ref for id 1 points at the refreshed commit.
    const refSha = git(['rev-parse', 'refs/wd/hashU/1'], repoA).stdout.trim();
    expect(refSha).toBe(res.entry.repos.repoA);
  });

  it('returns "unchanged" and preserves the ref when nothing changed', async () => {
    await takeCheckpoint('hashU2', [{ name: 'repoA', root: repoA }]); // #0
    writeFile(repoA, 'work.txt', 'turn 1\n');
    const live = await takeCheckpoint('hashU2', [{ name: 'repoA', root: repoA }]);
    const sha = live!.repos.repoA;

    const res = await updateCheckpoint('hashU2', [{ name: 'repoA', root: repoA }], 1);
    expect(res.status).toBe('unchanged');
    // Manifest entry + ref untouched.
    const manifest = loadManifest('hashU2');
    expect(manifest.entries[1].repos.repoA).toBe(sha);
    const refSha = git(['rev-parse', 'refs/wd/hashU2/1'], repoA).stdout.trim();
    expect(refSha).toBe(sha);
  });

  it('returns "missing" when the id does not exist', async () => {
    await takeCheckpoint('hashU3', [{ name: 'repoA', root: repoA }]); // #0 only
    const res = await updateCheckpoint('hashU3', [{ name: 'repoA', root: repoA }], 99);
    expect(res.status).toBe('missing');
  });

  it('clears the label on a real update so it gets re-summarised', async () => {
    await takeCheckpoint('hashU4', [{ name: 'repoA', root: repoA }]); // #0
    writeFile(repoA, 'work.txt', 'a\n');
    await takeCheckpoint('hashU4', [{ name: 'repoA', root: repoA }]); // #1
    // Pretend the SPA had already named it.
    const before = loadManifest('hashU4');
    before.entries[1].label = 'Old name';
    fs.writeFileSync(manifestPath('hashU4'), JSON.stringify(before, null, 2));

    writeFile(repoA, 'work.txt', 'a\nb\n');
    const res = await updateCheckpoint('hashU4', [{ name: 'repoA', root: repoA }], 1);
    expect(res.status).toBe('updated');
    expect(loadManifest('hashU4').entries[1].label).toBeUndefined();
  });
});

describe('clearCheckpoints', () => {
  it('removes manifest + every ref it created', async () => {
    await takeCheckpoint('hashX', [{ name: 'repoA', root: repoA }]);
    writeFile(repoA, 'README.md', '# v2\n');
    await takeCheckpoint('hashX', [{ name: 'repoA', root: repoA }]);

    expect(fs.existsSync(manifestPath('hashX'))).toBe(true);
    expect(
      git(['rev-parse', '--verify', '--quiet', 'refs/wd/hashX/0'], repoA)
        .exitCode,
    ).toBe(0);

    clearCheckpoints('hashX', [repoA]);

    expect(fs.existsSync(manifestPath('hashX'))).toBe(false);
    expect(
      git(['rev-parse', '--verify', '--quiet', 'refs/wd/hashX/0'], repoA)
        .exitCode,
    ).not.toBe(0);
    expect(
      git(['rev-parse', '--verify', '--quiet', 'refs/wd/hashX/1'], repoA)
        .exitCode,
    ).not.toBe(0);
  });
});
