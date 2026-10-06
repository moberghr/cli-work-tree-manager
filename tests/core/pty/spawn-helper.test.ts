import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { makeSpawnHelperExecutable, type ModeFs } from '../../../src/core/pty/spawn-helper.js';

/** A file system of modes; chmod records, and can be refused (a root-owned install). */
function fakeFs(modes: Record<string, number>, refuse = false) {
  const chmods: Array<[string, number]> = [];
  const f: ModeFs = {
    statSync: (p) => {
      if (!(p in modes)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mode: modes[p] };
    },
    chmodSync: (p, mode) => {
      if (refuse) throw new Error('EPERM: operation not permitted');
      chmods.push([p, mode]);
    },
  };
  return { f, chmods };
}

const dir = path.join('/opt', 'node_modules', 'node-pty');
const prebuild = path.join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
const built = path.join(dir, 'build', 'Release', 'spawn-helper');

describe('makeSpawnHelperExecutable', () => {
  it("makes the platform's prebuilt helper executable when it shipped 0644 (every terminal failed: posix_spawnp)", () => {
    const { f, chmods } = fakeFs({ [prebuild]: 0o100644 });
    expect(makeSpawnHelperExecutable(dir, 'darwin', 'arm64', f)).toEqual({ fixed: [prebuild], failed: [] });
    expect(chmods).toEqual([[prebuild, 0o755]]);
  });

  it('leaves an executable one alone, and a locally built one is checked too', () => {
    const { f, chmods } = fakeFs({ [prebuild]: 0o100755, [built]: 0o100600 });
    expect(makeSpawnHelperExecutable(dir, 'darwin', 'arm64', f)).toEqual({ fixed: [built], failed: [] });
    expect(chmods).toEqual([[built, 0o755]]);
  });

  it("says which it couldn't fix (a root-owned global install), and does nothing on Windows", () => {
    const { f } = fakeFs({ [prebuild]: 0o100644 }, true);
    expect(makeSpawnHelperExecutable(dir, 'darwin', 'arm64', f).failed).toEqual([
      { file: prebuild, error: 'EPERM: operation not permitted' },
    ]);
    const win = fakeFs({ [prebuild]: 0o100644 });
    expect(makeSpawnHelperExecutable(dir, 'win32', 'x64', win.f)).toEqual({ fixed: [], failed: [] });
    expect(win.chmods).toEqual([]);
  });
});
