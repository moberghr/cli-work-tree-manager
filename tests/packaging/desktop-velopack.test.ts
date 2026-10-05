import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliFiles, foreignPrebuilds, nodeName, stageCli } from '../../desktop/scripts/stage-cli.mjs';
import { PACK_ID, requiredAssets, target } from '../../desktop/scripts/velopack.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
let tmp: string | null = null;
afterEach(() => {
  vi.unstubAllEnvs();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('desktop: staging the work CLI into the app', () => {
  it('ships what the npm package ships, plus its lockfile for npm ci', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(cliFiles(pkg)).toEqual(['package.json', 'npm-shrinkwrap.json', ...pkg.files]);
    expect(pkg.files).toContain('dist');
  });

  it('drops only the other platforms’ prebuilt binaries', () => {
    const names = [
      'win32-x64',
      'win32-arm64',
      'darwin-arm64',
      'darwin-x64',
      'linux-x64.node',
      'linuxmusl-x64.node',
      'win32-x64.node',
      'README.md',
      'node.napi.node',
    ];
    expect(foreignPrebuilds(names, 'win32', 'x64')).toEqual([
      'win32-arm64',
      'darwin-arm64',
      'darwin-x64',
      'linux-x64.node',
      'linuxmusl-x64.node',
    ]);
    expect(foreignPrebuilds(names, 'linux', 'x64')).toEqual([
      'win32-x64',
      'win32-arm64',
      'darwin-arm64',
      'darwin-x64',
      'linuxmusl-x64.node',
      'win32-x64.node',
    ]);
  });

  it('stages the package files, this Node, and VERSION last (runtime.rs takes a cli/ with one as complete)', () => {
    // Not from a release job's WORK_VERSION (the tag): this package's own version.
    vi.stubEnv('WORK_VERSION', '');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cli-'));
    const root = path.join(tmp, 'pkg');
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'bin.js'), '');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9', files: ['dist'] }));
    fs.writeFileSync(path.join(root, 'npm-shrinkwrap.json'), '{}');
    const fakeNode = path.join(tmp, 'fake-node');
    fs.writeFileSync(fakeNode, 'node');
    const out = path.join(tmp, 'out');
    expect(stageCli(out, { root, node: fakeNode, install: false })).toBe('9.9.9');
    expect(fs.readFileSync(path.join(out, 'VERSION'), 'utf8')).toBe('9.9.9');
    expect(fs.existsSync(path.join(out, 'dist', 'bin.js'))).toBe(true);
    expect(fs.readFileSync(path.join(out, nodeName()), 'utf8')).toBe('node');
  });

  it('refuses to stage an unbuilt CLI', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-cli-'));
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ version: '1.0.0', files: ['dist'] }));
    expect(() => stageCli(path.join(tmp!, 'out'), { root: tmp!, install: false })).toThrow(/npm run build/);
  });
});

describe('desktop: the Velopack package per platform', () => {
  it('one channel per platform built, and nothing else', () => {
    expect(target('win32', 'x64')).toMatchObject({ rid: 'win-x64', channel: 'win', exe: 'work-desktop.exe' });
    expect(target('darwin', 'arm64')).toMatchObject({ rid: 'osx-arm64', channel: 'osx', exe: 'work-desktop' });
    expect(target('linux', 'x64')).toMatchObject({ rid: 'linux-x64', channel: 'linux' });
    expect(() => target('darwin', 'x64')).toThrow(/no desktop package/);
  });

  it('a published release must carry each channel’s feed and full package (vpk leaves the channel out of win’s name)', () => {
    expect(requiredAssets(target('win32', 'x64'), '2.1.0')).toEqual(['releases.win.json', `${PACK_ID}-2.1.0-full.nupkg`]);
    expect(requiredAssets(target('linux', 'x64'), '2.1.0')).toEqual(['releases.linux.json', `${PACK_ID}-2.1.0-linux-full.nupkg`]);
  });

  it('the app identity matches the Tauri config (the macOS bundle id is permanent)', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'src-tauri', 'tauri.conf.json'), 'utf8'));
    expect(conf.identifier).toBe('hr.moberg.work-desktop');
    expect(fs.readFileSync(path.join(ROOT, 'desktop', 'scripts', 'velopack.mjs'), 'utf8')).toContain(`BUNDLE_ID = '${conf.identifier}'`);
  });
});
