import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIgnoredWatchPath } from '../../src/core/fs-watcher.js';

const root = path.resolve('/repo');

describe('isIgnoredWatchPath', () => {
  it('ignores dependency dirs (node_modules) at any depth — EMFILE guard', () => {
    expect(isIgnoredWatchPath([root], path.join(root, 'node_modules'))).toBe(true);
    expect(
      isIgnoredWatchPath([root], path.join(root, 'node_modules', 'caniuse-lite', 'data.js')),
    ).toBe(true);
    expect(
      isIgnoredWatchPath([root], path.join(root, 'web', 'node_modules', 'react', 'index.js')),
    ).toBe(true);
  });

  it('ignores build-output dirs (the dominant fd sink on real repos)', () => {
    // .NET — what actually wedged the server (bin/obj full of DLLs).
    expect(
      isIgnoredWatchPath([root], path.join(root, 'PublicApiTests', 'bin', 'Debug', 'net10.0', 'x.dll')),
    ).toBe(true);
    expect(isIgnoredWatchPath([root], path.join(root, 'Api', 'obj', 'project.assets.json'))).toBe(true);
    // JS / other toolchains.
    expect(isIgnoredWatchPath([root], path.join(root, 'dist', 'bundle.js'))).toBe(true);
    expect(isIgnoredWatchPath([root], path.join(root, 'target', 'release', 'app'))).toBe(true);
    expect(isIgnoredWatchPath([root], path.join(root, '.next', 'cache', 'x'))).toBe(true);
  });

  it('ignores the .git directory and its contents', () => {
    expect(isIgnoredWatchPath([root], path.join(root, '.git'))).toBe(true);
    expect(isIgnoredWatchPath([root], path.join(root, '.git', 'HEAD'))).toBe(true);
  });

  it('does not ignore ordinary source files', () => {
    expect(isIgnoredWatchPath([root], path.join(root, 'src', 'index.ts'))).toBe(false);
    expect(isIgnoredWatchPath([root], path.join(root, 'README.md'))).toBe(false);
  });

  it('does not false-match files whose name merely contains an ignored token', () => {
    expect(isIgnoredWatchPath([root], path.join(root, 'docs', 'node_modules_guide.md'))).toBe(false);
    expect(isIgnoredWatchPath([root], path.join(root, 'src', 'distance.ts'))).toBe(false);
  });

  it('does not ignore everything when an ancestor of the root is named like a build dir', () => {
    // Root lives under a `build/` ancestor; paths below the root must still
    // be watched (the ignored check is relative to the root, not absolute).
    const nested = path.resolve('/home/build/myrepo');
    expect(isIgnoredWatchPath([nested], path.join(nested, 'src', 'main.ts'))).toBe(false);
    expect(isIgnoredWatchPath([nested], path.join(nested, 'dist', 'main.js'))).toBe(true);
  });

  it('handles multiple roots independently', () => {
    const a = path.resolve('/a');
    const b = path.resolve('/b');
    expect(isIgnoredWatchPath([a, b], path.join(b, 'node_modules', 'x.js'))).toBe(true);
    expect(isIgnoredWatchPath([a, b], path.join(b, 'src', 'x.ts'))).toBe(false);
  });
});
