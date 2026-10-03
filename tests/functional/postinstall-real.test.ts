import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * npm's postinstall, as npm runs it, against the BUILT entry it hands over to
 * (dist/install-skills-bin.js): under a throwaway HOME, with a `claude` on
 * PATH that fails — never the real one. It must say how it went and write
 * nothing to ~/.work (a `sudo npm i -g` would leave it owned by root).
 */

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'postinstall.mjs');
const hasBuild = fs.existsSync(path.join(ROOT, 'dist', 'install-skills-bin.js'));

let home: string;
let fakeBin: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-'));
  fakeBin = path.join(home, 'bin');
  fs.mkdirSync(fakeBin);
  // A `claude` that isn't working: the install reports it and goes on.
  if (process.platform === 'win32') fs.writeFileSync(path.join(fakeBin, 'claude.cmd'), '@exit /b 1\r\n');
  else {
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
  }
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe.skipIf(!hasBuild)('scripts/postinstall.mjs', () => {
  it('runs only the skills installer: says how each agent went, and writes nothing to ~/.work', () => {
    const { CI: _ci, WORK_TREE_SKIP_PLUGIN_SETUP: _skip, ...env } = process.env;
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const r = spawnSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...env, HOME: home, USERPROFILE: home, NO_COLOR: '1', [pathKey]: `${fakeBin}${path.delimiter}${env[pathKey] ?? ''}` },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('work-tree: Claude Code: Claude Code (the `claude` CLI) is not installed');
    expect(fs.existsSync(path.join(home, '.work'))).toBe(false);
  });

  it('CI (or the opt-out) skips it', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, CI: '1', HOME: home, USERPROFILE: home } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
