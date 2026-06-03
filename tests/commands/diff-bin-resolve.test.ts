import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveWorkBinPath } from '../../src/commands/diff.js';

describe('resolveWorkBinPath', () => {
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
