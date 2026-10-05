import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { versionFromDescribe, workVersion } from '../../scripts/version.mjs';

const root = (version: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-version-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  return dir;
};

describe('the version: the release tag, as in bearing', () => {
  it('git describe: on a tag, that tag; past it, above the last release (a dev build is never offered what it is ahead of)', () => {
    expect(versionFromDescribe('v2.0.1-0-gaeed538\n')).toBe('2.0.1');
    expect(versionFromDescribe('v2.0.1-3-gaeed538')).toBe('2.0.2-dev.3+aeed538');
    expect(versionFromDescribe('v1.9.0-12-g0123abc')).toBe('1.9.1-dev.12+0123abc');
    expect(versionFromDescribe('1.9.0-1-gabc')).toBeNull(); // not a v-tag
    expect(versionFromDescribe(null)).toBeNull();
  });

  it('WORK_VERSION (the release jobs set it from the tag) wins; a v is dropped; a non-version is refused', () => {
    const dir = root('0.0.0-dev');
    const describe = () => 'v2.0.1-3-gaeed538';
    expect(workVersion(dir, { env: { WORK_VERSION: '2.1.0' }, describe })).toBe('2.1.0');
    expect(workVersion(dir, { env: { WORK_VERSION: 'v2.1.0' }, describe })).toBe('2.1.0');
    expect(() => workVersion(dir, { env: { WORK_VERSION: 'latest' }, describe })).toThrow(/not a version/);
  });

  it('else git describe; with neither (a shallow clone), package.json', () => {
    const dir = root('0.0.0-dev');
    expect(workVersion(dir, { env: {}, describe: () => 'v2.0.1-3-gaeed538' })).toBe('2.0.2-dev.3+aeed538');
    expect(workVersion(dir, { env: {}, describe: () => null })).toBe('0.0.0-dev');
  });

  it("package.json keeps a placeholder: the number isn't kept in two places", () => {
    // As committed: a release job sets the working copy's from the tag before the tests run.
    const committed = spawnSync('git', ['show', 'HEAD:package.json'], { cwd: path.join(__dirname, '../..'), encoding: 'utf8' });
    const text = committed.status === 0 ? committed.stdout : fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8');
    expect((JSON.parse(text) as { version: string }).version).toBe('0.0.0-dev');
  });

  it('release.yml sets the version from the tag before anything is built or packed, in both jobs', () => {
    const wf = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
    const publish = wf.slice(wf.indexOf('  publish:'), wf.indexOf('  desktop:'));
    const desktop = wf.slice(wf.indexOf('  desktop:'));
    const before = (job: string, a: string, b: string) => job.indexOf(a) >= 0 && job.indexOf(a) < job.indexOf(b);
    expect(before(publish, 'Version from the release tag', 'npm run build')).toBe(true);
    expect(before(publish, 'npm run build', 'npm test')).toBe(true); // the functional tests serve dist/web
    expect(before(publish, 'Version from the release tag', 'npm publish')).toBe(true);
    expect(before(desktop, 'Version from the release tag', 'velopack.mjs')).toBe(true);
    // Each runs in bash, Windows too (its default shell is PowerShell).
    for (const job of [publish, desktop]) {
      const step = job.slice(job.indexOf('Version from the release tag'));
      expect(step.slice(0, step.indexOf('run:'))).toContain('shell: bash');
      expect(step).toContain('WORK_VERSION=$VERSION');
    }
  });
});
