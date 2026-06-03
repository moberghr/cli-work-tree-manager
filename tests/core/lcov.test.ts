import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLcov,
  coverageForFiles,
  coverageLookup,
  readParsedLcov,
  clearLcovCache,
  findLcov,
} from '../../src/core/lcov.js';

const SAMPLE = [
  'TN:',
  'SF:src/a.ts',
  'DA:1,1',
  'DA:2,0',
  'LF:4',
  'LH:3',
  'end_of_record',
  'TN:',
  'SF:src/b.ts',
  'DA:1,0',
  'DA:2,0',
  'LF:2',
  'LH:0',
  'end_of_record',
].join('\n');

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lcov-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('parseLcov', () => {
  it('computes per-file percent from LF/LH summary lines', () => {
    const m = parseLcov(SAMPLE);
    expect(m.get('src/a.ts')).toBeCloseTo(75); // 3/4
    expect(m.get('src/b.ts')).toBe(0); // 0/2
  });

  it('derives percent from DA records when LF/LH are absent', () => {
    const content = ['SF:x.ts', 'DA:1,5', 'DA:2,0', 'DA:3,2', 'end_of_record'].join('\n');
    const m = parseLcov(content);
    // 2 of 3 lines hit
    expect(m.get('x.ts')).toBeCloseTo((2 / 3) * 100);
  });

  it('tolerates a trailing record with no end_of_record', () => {
    const content = ['SF:y.ts', 'LF:10', 'LH:10'].join('\n');
    const m = parseLcov(content);
    expect(m.get('y.ts')).toBe(100);
  });
});

describe('coverageForFiles', () => {
  it('matches absolute SF paths normalized to repo-relative', () => {
    const root = mkTmp();
    const abs = [
      `SF:${path.join(root, 'src/a.ts')}`,
      'LF:4',
      'LH:1',
      'end_of_record',
    ].join('\n');
    fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(root, 'coverage', 'lcov.info'), abs);

    const cov = coverageForFiles(root, ['src/a.ts', 'src/missing.ts']);
    expect(cov.get('src/a.ts')).toBeCloseTo(25); // 1/4
    expect(cov.has('src/missing.ts')).toBe(false);
  });

  it('matches relative SF paths', () => {
    const root = mkTmp();
    fs.writeFileSync(path.join(root, 'lcov.info'), SAMPLE);
    const cov = coverageForFiles(root, ['src/a.ts']);
    expect(cov.get('src/a.ts')).toBeCloseTo(75);
  });

  it('returns empty map when no lcov is present', () => {
    const root = mkTmp();
    const cov = coverageForFiles(root, ['src/a.ts']);
    expect(cov.size).toBe(0);
  });
});

describe('readParsedLcov (mtime cache)', () => {
  it('memoizes by (path, mtimeMs) and re-parses only when mtime changes', () => {
    clearLcovCache();
    const root = mkTmp();
    const lcovPath = path.join(root, 'lcov.info');
    fs.writeFileSync(lcovPath, SAMPLE);
    // Pin a known mtime so we control invalidation deterministically.
    const t0 = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(lcovPath, t0, t0);

    const first = readParsedLcov(lcovPath);
    const second = readParsedLcov(lcovPath);
    expect(first).not.toBeNull();
    // Same mtime → identical (cached) parsed Map instance, no re-parse.
    expect(second!.parsed).toBe(first!.parsed);
    expect(second!.mtimeMs).toBe(first!.mtimeMs);

    // Rewrite with a newer mtime → cache invalidated, fresh Map instance.
    const newContent = ['SF:src/a.ts', 'LF:2', 'LH:2', 'end_of_record'].join('\n');
    fs.writeFileSync(lcovPath, newContent);
    const t1 = new Date('2020-06-01T00:00:00Z');
    fs.utimesSync(lcovPath, t1, t1);
    const third = readParsedLcov(lcovPath);
    expect(third!.parsed).not.toBe(first!.parsed);
    expect(third!.parsed.get('src/a.ts')).toBe(100);
    expect(third!.mtimeMs).not.toBe(first!.mtimeMs);
  });

  it('returns null and evicts the cache entry when the file disappears', () => {
    clearLcovCache();
    const root = mkTmp();
    const lcovPath = path.join(root, 'lcov.info');
    fs.writeFileSync(lcovPath, SAMPLE);
    expect(readParsedLcov(lcovPath)).not.toBeNull();
    fs.rmSync(lcovPath);
    expect(readParsedLcov(lcovPath)).toBeNull();
  });
});

describe('coverageLookup (mtime + realpath)', () => {
  it('surfaces the lcov mtime alongside matched coverage', () => {
    clearLcovCache();
    const root = mkTmp();
    const lcovPath = path.join(root, 'lcov.info');
    fs.writeFileSync(lcovPath, SAMPLE);
    const statMtime = fs.statSync(lcovPath).mtimeMs;
    const r = coverageLookup(root, ['src/a.ts']);
    expect(r.byPath.get('src/a.ts')).toBeCloseTo(75);
    expect(r.lcovMtimeMs).toBe(statMtime);
  });

  it('reports lcovMtimeMs as null when no lcov is present', () => {
    clearLcovCache();
    const root = mkTmp();
    expect(coverageLookup(root, ['src/a.ts']).lcovMtimeMs).toBeNull();
  });

  it('matches absolute SF paths when the root and SF realpaths diverge (symlink)', () => {
    // Reproduce macOS /tmp -> /private/tmp style divergence: the lcov SF:
    // paths are written under the REAL (canonical) location, while callers
    // pass the SYMLINKED root. Without realpath normalization on both sides,
    // path.relative comes out `..`-prefixed and the match is silently lost.
    clearLcovCache();
    const realDir = mkTmp();
    const linkDir = path.join(os.tmpdir(), `lcov-link-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.symlinkSync(realDir, linkDir);
    tmpDirs.push(linkDir);

    // SF: paths reference the canonical (real) directory.
    const realRoot = fs.realpathSync(realDir);
    const abs = [
      `SF:${path.join(realRoot, 'src/a.ts')}`,
      'LF:4',
      'LH:1',
      'end_of_record',
    ].join('\n');
    fs.writeFileSync(path.join(linkDir, 'lcov.info'), abs);

    // Caller passes the symlinked root.
    const r = coverageLookup(linkDir, ['src/a.ts']);
    expect(r.byPath.get('src/a.ts')).toBeCloseTo(25); // 1/4 — match survives divergence
  });
});

describe('findLcov', () => {
  it('returns null when no lcov file exists', () => {
    const root = mkTmp();
    expect(findLcov(root)).toBeNull();
  });

  it('prefers coverage/lcov.info over root lcov.info', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(root, 'coverage', 'lcov.info'), '');
    fs.writeFileSync(path.join(root, 'lcov.info'), '');
    expect(findLcov(root)).toBe(path.join(root, 'coverage', 'lcov.info'));
  });
});
