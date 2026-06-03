import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIgnoredWatchPath } from '../../src/core/fs-watcher.js';

const root = path.resolve('/repo');

describe('isIgnoredWatchPath', () => {
  it('ignores node_modules anywhere in the tree (EMFILE guard)', () => {
    expect(isIgnoredWatchPath([root], path.join(root, 'node_modules'))).toBe(true);
    expect(
      isIgnoredWatchPath([root], path.join(root, 'node_modules', 'caniuse-lite', 'data.js')),
    ).toBe(true);
    // Nested node_modules (e.g. a sub-package's deps) is also skipped.
    expect(
      isIgnoredWatchPath([root], path.join(root, 'web', 'node_modules', 'react', 'index.js')),
    ).toBe(true);
  });

  it('ignores the .git directory and its contents', () => {
    expect(isIgnoredWatchPath([root], path.join(root, '.git'))).toBe(true);
    expect(isIgnoredWatchPath([root], path.join(root, '.git', 'HEAD'))).toBe(true);
  });

  it('does not ignore ordinary source files', () => {
    expect(isIgnoredWatchPath([root], path.join(root, 'src', 'index.ts'))).toBe(false);
    expect(isIgnoredWatchPath([root], path.join(root, 'README.md'))).toBe(false);
  });

  it('does not false-match files whose name merely contains node_modules', () => {
    expect(
      isIgnoredWatchPath([root], path.join(root, 'docs', 'node_modules_guide.md')),
    ).toBe(false);
  });

  it('handles multiple roots independently', () => {
    const a = path.resolve('/a');
    const b = path.resolve('/b');
    expect(isIgnoredWatchPath([a, b], path.join(b, 'node_modules', 'x.js'))).toBe(true);
    expect(isIgnoredWatchPath([a, b], path.join(b, 'src', 'x.ts'))).toBe(false);
  });
});
