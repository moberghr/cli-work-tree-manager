import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  computeDiff,
  computeRangeDiff,
  isInsideRoot,
} from '../../src/core/diff-pipeline.js';
import { snapshotRepo } from '../../src/core/checkpoint.js';
import { git } from '../../src/core/git.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-diff-pl-'));
  git(['init', '-b', 'main'], tmpDir);
  git(['config', 'user.email', 't@t.t'], tmpDir);
  git(['config', 'user.name', 'Test'], tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function commit(msg: string) {
  git(['add', '.'], tmpDir);
  git(['commit', '-m', msg, '--no-gpg-sign'], tmpDir);
}

describe('isInsideRoot', () => {
  it('accepts a plain relative path', () => {
    expect(isInsideRoot('/repo', 'src/foo.md')).toBe(true);
  });
  it('accepts the root itself', () => {
    expect(isInsideRoot('/repo', '')).toBe(true);
  });
  it('rejects a `..` traversal', () => {
    expect(isInsideRoot('/repo', '../etc/passwd')).toBe(false);
    expect(isInsideRoot('/repo', '../../etc/passwd')).toBe(false);
  });
  it('rejects an absolute path', () => {
    // Use a path that's obviously outside any tmp/repo dir.
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
    expect(isInsideRoot('/repo', outside)).toBe(false);
  });
  it('rejects a path that uses `..` after a legit-looking prefix', () => {
    expect(isInsideRoot('/repo', 'src/../../etc/passwd')).toBe(false);
  });
});

describe('computeDiff mdContent', () => {
  it('populates before and after for a modified markdown file', () => {
    write('README.md', '# old\nfirst version\n');
    commit('init');
    write('README.md', '# new\nsecond version\n');

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const readme = files.find((f) => f.path === 'README.md');
    expect(readme).toBeDefined();
    expect(readme!.mdContent?.before).toContain('# old');
    expect(readme!.mdContent?.before).toContain('first version');
    expect(readme!.mdContent?.after).toContain('# new');
    expect(readme!.mdContent?.after).toContain('second version');
  });

  it('populates only after for an added (untracked) markdown file', () => {
    write('README.md', '# seed\n');
    commit('init');
    write('NEW.md', '# brand new\nhello\n');

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const added = files.find((f) => f.path === 'NEW.md');
    expect(added).toBeDefined();
    expect(added!.status).toBe('added');
    expect(added!.mdContent?.before).toBeUndefined();
    expect(added!.mdContent?.after).toContain('brand new');
  });

  it('populates only before for a deleted markdown file', () => {
    write('DOOMED.md', '# soon gone\n');
    write('keep.txt', 'x');
    commit('init');
    fs.unlinkSync(path.join(tmpDir, 'DOOMED.md'));

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const deleted = files.find((f) => f.path === 'DOOMED.md');
    expect(deleted).toBeDefined();
    expect(deleted!.status).toBe('deleted');
    expect(deleted!.mdContent?.before).toContain('soon gone');
    expect(deleted!.mdContent?.after).toBeUndefined();
  });

  it('populates both sides for a renamed markdown file', () => {
    write('OLD.md', '# header\nbody line\nbody line two\n');
    commit('init');
    // Use git mv so the rename is detected. Add a content edit so the
    // similarity-detection threshold is still met but content differs.
    git(['mv', 'OLD.md', 'NEW.md'], tmpDir);
    write('NEW.md', '# header\nbody line\nbody line two\nadded\n');

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const renamed = files.find(
      (f) => f.oldPath === 'OLD.md' || f.newPath === 'NEW.md',
    );
    expect(renamed).toBeDefined();
    expect(renamed!.mdContent?.before).toContain('header');
    expect(renamed!.mdContent?.after).toContain('added');
  });

  it('omits mdContent for non-markdown files', () => {
    write('script.ts', 'export const x = 1;\n');
    commit('init');
    write('script.ts', 'export const x = 2;\n');

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const ts = files.find((f) => f.path === 'script.ts');
    expect(ts).toBeDefined();
    expect(ts!.mdContent).toBeUndefined();
  });

  it('range diff between two snapshots resolves markdown content from each side', () => {
    write('README.md', '# v1\n');
    commit('init');
    write('README.md', '# v2\n');
    const fromSha = snapshotRepo(tmpDir, 'rangetest', 0);
    write('README.md', '# v3\n');
    const toSha = snapshotRepo(tmpDir, 'rangetest', 1);
    expect(fromSha).toBeTruthy();
    expect(toSha).toBeTruthy();

    const files = computeRangeDiff({
      root: tmpDir,
      fromRef: fromSha!,
      toRef: toSha!,
    });
    const readme = files.find((f) => f.path === 'README.md');
    expect(readme).toBeDefined();
    expect(readme!.mdContent?.before).toContain('# v2');
    expect(readme!.mdContent?.after).toContain('# v3');
  });

  it('range diff with toRef="working" matches computeDiff against the same fromRef', () => {
    write('a.md', '# a\n');
    commit('init');
    write('a.md', '# a-new\n');
    write('untracked.md', '# u\n');

    const direct = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const range = computeRangeDiff({
      root: tmpDir,
      fromRef: 'HEAD',
      toRef: 'working',
    });
    expect(range.map((f) => f.path).sort()).toEqual(
      direct.map((f) => f.path).sort(),
    );
  });

  it('handles a root whose ancestor is itself a symlink (macOS /tmp case)', () => {
    // On macOS `/tmp` is a symlink to `/private/tmp`. The realpath
    // guard needs to canonicalise BOTH sides of the comparison;
    // otherwise every working-tree markdown read fails silently.
    // We simulate by making the repo's parent a symlink and using
    // that link path as the root for computeDiff.
    const realParent = fs.mkdtempSync(
      path.join(os.tmpdir(), 'wd-realparent-'),
    );
    const linkedParent = path.join(os.tmpdir(), `wd-linkparent-${Date.now()}`);
    try {
      try {
        fs.symlinkSync(realParent, linkedParent);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
        throw err;
      }
      const repoViaLink = path.join(linkedParent, 'r');
      const repoReal = path.join(realParent, 'r');
      fs.mkdirSync(repoReal);
      git(['init', '-b', 'main'], repoReal);
      git(['config', 'user.email', 't@t.t'], repoReal);
      git(['config', 'user.name', 'Test'], repoReal);
      fs.writeFileSync(path.join(repoReal, 'README.md'), '# v1\n');
      git(['add', '.'], repoReal);
      git(['commit', '-m', 'init', '--no-gpg-sign'], repoReal);
      fs.writeFileSync(path.join(repoReal, 'README.md'), '# v2\n');

      // Use the SYMLINKED parent path as the root — this is what the
      // bug triggered on macOS where the user opens a worktree under
      // `/tmp` and `fs.realpathSync` resolves through `/private/tmp`.
      const files = computeDiff({ root: repoViaLink, diffArg: 'HEAD' });
      const readme = files.find((f) => f.path === 'README.md');
      expect(readme).toBeDefined();
      // Before the fix this came out undefined because the realpath of
      // the file lived in a different namespace from the lexical root.
      expect(readme!.mdContent?.after).toContain('# v2');
    } finally {
      try { fs.unlinkSync(linkedParent); } catch { /* */ }
      fs.rmSync(realParent, { recursive: true, force: true });
    }
  });

  it('caps mdContent and sets tooLarge when content exceeds the size limit', () => {
    // 300 KiB exceeds the 256 KiB cap — should drop content and flag tooLarge.
    const huge = '# big\n' + 'x'.repeat(300 * 1024) + '\n';
    write('big.md', huge);
    commit('init');
    write('big.md', huge + 'edit\n');

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const big = files.find((f) => f.path === 'big.md');
    expect(big).toBeDefined();
    expect(big!.mdContent?.tooLarge).toBe(true);
    expect(big!.mdContent?.before).toBeUndefined();
    expect(big!.mdContent?.after).toBeUndefined();
  });

  it('does not synthesize phantom "added" entries for untracked files already in fromRef', () => {
    // Long-standing untracked file captured by a checkpoint.
    // computeRangeDiff(checkpointSha → working) must not also synthesize
    // the file as "added" when its content is unchanged since the snapshot.
    write('seed.md', '# seed\n');
    commit('init');
    write('notes.md', '# my notes\n'); // never staged — untracked
    const cpSha = snapshotRepo(tmpDir, 'phantom', 0);
    expect(cpSha).toBeTruthy();

    write('seed.md', '# seed v2\n'); // modify a tracked file

    const files = computeRangeDiff({
      root: tmpDir,
      fromRef: cpSha!,
      toRef: 'working',
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('seed.md');
    expect(paths).not.toContain('notes.md');
  });

  it('detects a rename (+ edit) across a checkpoint range as one renamed entry', () => {
    // -M on the diff-tree path must pair the deleted old path with the
    // added new path instead of rendering them as a separate add + delete.
    write('old.txt', 'line1\nline2\nline3\nline4\nline5\n');
    commit('init');
    const cpSha = snapshotRepo(tmpDir, 'rename', 0);
    expect(cpSha).toBeTruthy();

    git(['mv', 'old.txt', 'new.txt'], tmpDir);
    write('new.txt', 'line1\nline2\nline3 edited\nline4\nline5\n');

    const files = computeRangeDiff({
      root: tmpDir,
      fromRef: cpSha!,
      toRef: 'working',
    });
    const renamed = files.find((f) => f.status === 'renamed');
    expect(renamed).toBeDefined();
    expect(renamed!.oldPath).toBe('old.txt');
    expect(renamed!.newPath).toBe('new.txt');
    expect(files.some((f) => f.status === 'added' && f.path === 'new.txt')).toBe(
      false,
    );
    expect(
      files.some((f) => f.status === 'deleted' && f.path === 'old.txt'),
    ).toBe(false);
  });

  it('does not read symlinks that target paths outside the repo root', () => {
    // On Windows, creating a regular file symlink requires Developer
    // Mode / Admin. Skip when symlink() throws EPERM rather than fail.
    const secret = path.join(os.tmpdir(), 'wd-sym-secret.md');
    fs.writeFileSync(secret, '# SECRET — should not be exfiltrated\n');
    const linkPath = path.join(tmpDir, 'leak.md');
    write('seed.md', '# seed\n');
    commit('init');
    try {
      try {
        fs.symlinkSync(secret, linkPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EPERM') {
          // Skip — can't create symlink in this environment.
          return;
        }
        throw err;
      }
      const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
      const leak = files.find((f) => f.path === 'leak.md');
      expect(leak).toBeDefined();
      // Critical assertion: the secret content must NOT appear in the
      // mdContent payload. Before the realpath check, this leaked.
      expect(leak!.mdContent?.after).toBeUndefined();
    } finally {
      try { fs.unlinkSync(linkPath); } catch { /* */ }
      try { fs.unlinkSync(secret); } catch { /* */ }
    }
  });

  it('recognises .markdown and .mdx extensions', () => {
    write('a.markdown', '# a\n');
    write('b.mdx', '# b\n');
    commit('init');
    write('a.markdown', '# a2\n');
    write('b.mdx', '# b2\n');

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const a = files.find((f) => f.path === 'a.markdown');
    const b = files.find((f) => f.path === 'b.mdx');
    expect(a!.mdContent?.before).toContain('# a');
    expect(a!.mdContent?.after).toContain('# a2');
    expect(b!.mdContent?.before).toContain('# b');
    expect(b!.mdContent?.after).toContain('# b2');
  });
});

describe('computeDiff coverage', () => {
  it('attaches coverage + lcov mtime, and flags staleness when source is newer than lcov', () => {
    write('src/a.ts', 'export const x = 1;\n');
    commit('init');
    write('src/a.ts', 'export const x = 2;\n');

    // lcov measured at a fixed point in the past.
    const lcov = [
      'SF:src/a.ts',
      'DA:1,1',
      'LF:4',
      'LH:3',
      'end_of_record',
    ].join('\n');
    write('coverage/lcov.info', lcov);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmpDir, 'coverage', 'lcov.info'), past, past);
    // Make the source file clearly NEWER than the lcov.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(tmpDir, 'src', 'a.ts'), future, future);

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const a = files.find((f) => f.path === 'src/a.ts');
    expect(a).toBeDefined();
    expect(a!.coverage).toBeCloseTo(75); // 3/4
    expect(typeof a!.coverageMtimeMs).toBe('number');
    // Source mtime > lcov mtime → stale.
    expect(a!.coverageStale).toBe(true);
  });

  it('does not flag staleness when lcov is newer than the source', () => {
    write('src/b.ts', 'export const y = 1;\n');
    commit('init');
    write('src/b.ts', 'export const y = 2;\n');

    const lcov = ['SF:src/b.ts', 'LF:2', 'LH:2', 'end_of_record'].join('\n');
    write('coverage/lcov.info', lcov);
    // lcov clearly newer than the source file.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(tmpDir, 'src', 'b.ts'), old, old);
    const now = new Date();
    fs.utimesSync(path.join(tmpDir, 'coverage', 'lcov.info'), now, now);

    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const b = files.find((f) => f.path === 'src/b.ts');
    expect(b!.coverage).toBe(100);
    expect(b!.coverageStale).toBeFalsy();
  });

  it('leaves coverage undefined when no lcov is present', () => {
    write('src/c.ts', 'export const z = 1;\n');
    commit('init');
    write('src/c.ts', 'export const z = 2;\n');
    const files = computeDiff({ root: tmpDir, diffArg: 'HEAD' });
    const c = files.find((f) => f.path === 'src/c.ts');
    expect(c!.coverage).toBeUndefined();
    expect(c!.coverageMtimeMs).toBeUndefined();
  });
});
