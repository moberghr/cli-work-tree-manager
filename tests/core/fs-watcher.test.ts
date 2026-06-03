import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFsWatcher, isIgnoredWatchPath } from '../../src/core/fs-watcher.js';

const root = path.resolve('/repo');

/** Wait up to `ms` for `cond()` to hold, polling every 25ms. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

describe('createFsWatcher', () => {
  it('fires onChange for a tracked file and stays quiet after stop()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-fsw-'));
    let hits = 0;
    const watcher = createFsWatcher({
      roots: [dir],
      debounceMs: 20,
      onChange: () => {
        hits += 1;
      },
    });
    try {
      // Give the OS watch a moment to arm, then touch a real file.
      await new Promise((r) => setTimeout(r, 100));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
      expect(await waitFor(() => hits > 0)).toBe(true);

      const afterStart = hits;
      watcher.stop();
      await new Promise((r) => setTimeout(r, 50));
      fs.writeFileSync(path.join(dir, 'b.txt'), 'world');
      await new Promise((r) => setTimeout(r, 150));
      expect(hits).toBe(afterStart); // no events after stop()
    } finally {
      watcher.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
