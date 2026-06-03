import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWebRoot } from '../../src/core/web-static.js';

// The directory the resolver derives from import.meta.url (the bundle's own
// location at runtime). In the build, src/core/web-static.ts is inlined into
// dist/<bin>.js, so dist/web is a sibling of this module's directory.
const moduleDir = path.dirname(
  fileURLToPath(new URL('../../src/core/web-static.ts', import.meta.url)),
);

describe('resolveWebRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds dist/web as a sibling of the module even when argv[1] is an npm bin symlink', async () => {
    // Simulate a global install: argv[1] points at the (non-realpath'd) bin
    // symlink dir, so the entryDir candidate misses. Only the module-dir
    // sibling candidate should match — the regression this guards against.
    const argvSpy = vi
      .spyOn(process, 'argv', 'get')
      .mockReturnValue(['node', '/usr/local/bin/wd']);
    const siblingWeb = path.join(moduleDir, 'web');
    const fs = await import('node:fs');
    vi.spyOn(fs.default, 'existsSync').mockImplementation((p) =>
      String(p).startsWith(siblingWeb),
    );

    expect(resolveWebRoot()).toBe(siblingWeb);
    argvSpy.mockRestore();
  });

  it('returns null when no candidate has an index.html', async () => {
    const fs = await import('node:fs');
    vi.spyOn(fs.default, 'existsSync').mockReturnValue(false);
    expect(resolveWebRoot()).toBeNull();
  });
});
