import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { packCliArchive, trimmable } from '../../desktop/scripts/stage-cli.mjs';
import { listFiles, readStoredZip, zipDirectory } from '../../desktop/scripts/zip-store.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-archive-'));
  dirs.push(d);
  return d;
};
const put = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

describe('the bundled CLI: trimmed, and one zip', () => {
  it('trims what nothing runs, keeps code, licenses and native binaries', () => {
    for (const rel of [
      'zod/README.md',
      'zod/v4/index.d.ts',
      'zod/v4/index.d.cts',
      'hono/dist/index.js.map',
      'node-pty/prebuilds/win32-x64/conpty.pdb',
      'zod/src/v4/core.ts',
      'glob/test/a.js',
      'yargs/docs/api.html',
      'some/__tests__/x.js',
      'better-sqlite3/deps/sqlite3/sqlite3.c',
      'node-pty/src/win/conpty.cc',
    ])
      expect(trimmable(rel), rel).toBe(true);
    for (const rel of [
      'zod/v4/index.js',
      'zod/package.json',
      'zod/LICENSE',
      'hono/LICENSE.md',
      'better-sqlite3/build/Release/better_sqlite3.node',
      'better-sqlite3/lib/index.js',
      'node-pty/lib/index.js',
      'node-pty/prebuilds/win32-x64/pty.node',
      'node-pty/third_party/conpty/1.22/win10-x64/conpty.dll',
      'yargs/locales/en.json',
    ])
      expect(trimmable(rel), rel).toBe(false);
  });

  it('a stored zip that reads back the same: sorted names, each file, deterministic bytes', () => {
    const src = tmp();
    put(src, 'dist/bin.js', 'console.log(1)\n');
    put(src, 'node_modules/ą-pkg/index.js', 'module.exports = "ü";\n'); // UTF-8 names
    put(src, 'VERSION', '2.0.2');
    const out = tmp();
    expect(zipDirectory(src, path.join(out, 'a.zip'))).toBe(3);
    const entries = readStoredZip(path.join(out, 'a.zip'));
    expect(entries.map((e) => e.name)).toEqual(listFiles(src));
    expect(entries.map((e) => e.name)).toEqual(['VERSION', 'dist/bin.js', 'node_modules/ą-pkg/index.js']);
    expect(entries[2].data.toString('utf8')).toBe('module.exports = "ü";\n');
    // The same input gives the same bytes (fixed timestamps): reproducible packages.
    zipDirectory(src, path.join(out, 'b.zip'));
    expect(fs.readFileSync(path.join(out, 'a.zip')).equals(fs.readFileSync(path.join(out, 'b.zip')))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps Unix modes (node-pty’s spawn-helper must stay executable)', () => {
    const src = tmp();
    put(src, 'spawn-helper', '#!/bin/sh\n');
    fs.chmodSync(path.join(src, 'spawn-helper'), 0o755);
    const out = path.join(tmp(), 'm.zip');
    zipDirectory(src, out);
    expect(readStoredZip(out)[0].mode).toBe(0o755);
  });

  // An independent reader: bsdtar (Windows' tar.exe, macOS's tar) reads zips.
  const bsdtar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : process.platform === 'darwin' ? '/usr/bin/tar' : null;
  it.skipIf(!bsdtar || !fs.existsSync(bsdtar))('another zip reader lists and unpacks it the same', () => {
    const src = tmp();
    put(src, 'dist/bin.js', 'console.log(1)\n');
    put(src, 'node_modules/p/index.js', 'x');
    const zip = path.join(tmp(), 'c.zip');
    zipDirectory(src, zip);
    const list = spawnSync(bsdtar!, ['-tf', zip], { encoding: 'utf8' });
    expect(list.status).toBe(0);
    expect(list.stdout.trim().split(/\r?\n/)).toEqual(['dist/bin.js', 'node_modules/p/index.js']);
    const dest = tmp();
    expect(spawnSync(bsdtar!, ['-xf', zip, '-C', dest]).status).toBe(0);
    expect(fs.readFileSync(path.join(dest, 'node_modules', 'p', 'index.js'), 'utf8')).toBe('x');
  });

  it('packCliArchive: cli.zip and cli.version beside the folder, which goes', () => {
    const parent = tmp();
    const cli = path.join(parent, 'cli');
    put(cli, 'dist/bin.js', 'x');
    put(cli, 'node.exe', 'n');
    put(cli, 'VERSION', '2.0.2\n');
    const r = packCliArchive(cli);
    expect(r).toMatchObject({ version: '2.0.2', files: 3 });
    expect(fs.existsSync(cli)).toBe(false);
    expect(fs.readFileSync(path.join(parent, 'cli.version'), 'utf8')).toBe('2.0.2');
    expect(readStoredZip(path.join(parent, 'cli.zip')).map((e) => e.name)).toEqual(['VERSION', 'dist/bin.js', 'node.exe']);
  });

  it("the Rust test's fixture is this writer's zip (runtime.rs unpacks what stage-cli.mjs writes)", () => {
    const fixture = path.join(__dirname, '../../desktop/src-tauri/src/testdata/cli-fixture.zip');
    expect(readStoredZip(fixture).map((e) => e.name)).toEqual([
      'dist/bin.js',
      'node',
      'node.exe',
      'node_modules/pkg/index.js',
      'node_modules/pkg/package.json',
    ]);
  });
});
