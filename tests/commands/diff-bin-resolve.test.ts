import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkBinPath, webServerResponds } from '../../src/commands/diff.js';

/** Windows refuses symlink creation without elevation / Developer Mode
 *  (EPERM). Probe once so the symlink-specific case skips cleanly there
 *  instead of failing, while still running on CI and Unix. */
function symlinkSupported(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'work-symprobe-'));
  try {
    const target = path.join(probe, 'target');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
const CAN_SYMLINK = symlinkSupported();

describe('resolveWorkBinPath', () => {
  it.skipIf(!CAN_SYMLINK)('resolves a bin symlink (global install) before the swap', () => {
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

describe('webServerResponds', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when the server answers 2xx at api/context', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    expect(await webServerResponds('http://127.0.0.1:1234/')).toBe(true);
    // Probes the same endpoint work web's own singleton check uses.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:1234/api/context',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns false on a non-ok response (stale process holding the port)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    expect(await webServerResponds('http://127.0.0.1:1234/')).toBe(false);
  });

  it('returns false when the connection is refused (dead url file)', async () => {
    // The real bug: web.url survives a crashed server. fetch rejects with
    // ECONNREFUSED; we must report the URL as not-live so autostart fires.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }));
    expect(await webServerResponds('http://127.0.0.1:59289/')).toBe(false);
  });

  it('returns false (does not hang) when the server never responds', async () => {
    // fetch that respects the abort signal — simulates a hung port.
    vi.stubGlobal('fetch', vi.fn((_url: string, opts: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      }),
    ));
    expect(await webServerResponds('http://127.0.0.1:1234/', 50)).toBe(false);
  });
});
