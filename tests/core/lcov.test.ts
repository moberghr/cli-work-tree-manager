import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLcov, coverageForFiles, findLcov } from '../../src/core/lcov.js';

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
