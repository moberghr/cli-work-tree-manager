import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkBinPath } from '../../src/commands/diff.js';

describe('resolveWorkBinPath', () => {
  it('resolves a bin symlink (global install) before the swap', () => {
    // The real bug: a global npm install exposes `wd` as a symlink
    // (~/.../bin/wd -> dist/wd-bin.js). argv[1] is the symlink, which
    // doesn't end in `wd-bin.js`, so the swap was skipped and autostart
    // spawned the `wd` shim with `web` args. Resolve the symlink first.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'work-bin-'));
    try {
      const dist = path.join(tmp, 'dist');
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(dist, 'wd-bin.js'), '');
      fs.writeFileSync(path.join(dist, 'bin.js'), '');
      const binDir = path.join(tmp, 'bin');
      fs.mkdirSync(binDir);
      const wdLink = path.join(binDir, 'wd');
      fs.symlinkSync(path.join(dist, 'wd-bin.js'), wdLink);

      expect(resolveWorkBinPath(wdLink)).toBe(
        fs.realpathSync(path.join(dist, 'bin.js')),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('swaps wd-bin.js → bin.js in the same directory', () => {
    // Bug we're guarding against: autostart used to spawn
    // `node <argv[1]> web --lean`, but argv[1] was `wd-bin.js`
    // which only registers the `diff` command, producing
    // "Unknown arguments: lean, open" in the autostart log.
    const wdShim = path.join('C:', 'wd-tree', 'dist', 'wd-bin.js');
    expect(resolveWorkBinPath(wdShim)).toBe(
      path.join('C:', 'wd-tree', 'dist', 'bin.js'),
    );
  });

  it('returns the same path when we are already the work binary', () => {
    const workBin = path.join('/opt', 'work-tree', 'dist', 'bin.js');
    expect(resolveWorkBinPath(workBin)).toBe(workBin);
  });

  it('handles unusual file names (no swap)', () => {
    // Defensive — if someone renames the binary, don't silently
    // redirect to a sibling that may not exist.
    const renamed = path.join('/usr', 'local', 'bin', 'my-wd.js');
    expect(resolveWorkBinPath(renamed)).toBe(renamed);
  });

  it('uses dirname of the input, not cwd', () => {
    // Sanity check that path.dirname is used correctly when the
    // input lives at a deep nested path.
    const deep = path.join(
      'C:',
      'Users',
      'me',
      'projects',
      'work-tree',
      'dist',
      'wd-bin.js',
    );
    expect(resolveWorkBinPath(deep)).toBe(
      path.join(
        'C:',
        'Users',
        'me',
        'projects',
        'work-tree',
        'dist',
        'bin.js',
      ),
    );
  });
});
