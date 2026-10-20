import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensureShellPath,
  mergePath,
  parseShellPath,
  readShellPath,
  shellPathArgs,
  shellPathSpawnOptions,
} from '../../../src/core/platform/shell-path.js';

const D = path.delimiter;
const join = (...dirs: string[]) => dirs.join(D);
/** A PATH lookup over a made-up file system: which folder has which command. */
const finder = (has: Record<string, string>) => (cmd: string, env: NodeJS.ProcessEnv) =>
  (env.PATH ?? '').split(D).find((d) => has[cmd] === d) ?? null;

describe("the login shell's PATH, for a work the Mac app started from the Dock (reported: every session 'exited with code 1')", () => {
  const dock = join('/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Users/m/.work/bin');
  const shell = join('/Users/m/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin');

  it('claude missing: the shell is asked and its PATH goes first, keeping what only we had (~/.work/bin)', () => {
    const env: NodeJS.ProcessEnv = { PATH: dock };
    const asked: string[] = [];
    const r = ensureShellPath(['claude'], {
      platform: 'darwin',
      env,
      readPath: () => (asked.push('shell'), { path: shell }),
      find: finder({ claude: '/Users/m/.local/bin' }),
    });
    expect(r).toBe('added');
    expect(asked).toEqual(['shell']);
    expect(env.PATH).toBe(join('/Users/m/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Users/m/.work/bin'));
  });

  it('found already (started from a terminal), or on Windows: the shell is never asked', () => {
    const readPath = (): { path: string } => {
      throw new Error('should not ask');
    };
    const env = { PATH: shell };
    expect(ensureShellPath(['claude'], { platform: 'darwin', env, readPath, find: finder({ claude: '/Users/m/.local/bin' }) })).toBe(
      'found',
    );
    expect(env.PATH).toBe(shell);
    expect(ensureShellPath(['claude'], { platform: 'win32', env: { PATH: '' }, readPath })).toBe('found');
  });

  it("a shell that can't say leaves PATH as it was", () => {
    const env = { PATH: dock };
    expect(ensureShellPath(['claude'], { platform: 'linux', env, readPath: () => ({ why: 'timed out' }), find: () => null })).toBe(
      'unavailable',
    );
    expect(env.PATH).toBe(dock);
  });

  it('reads the PATH between the markers, whatever an interactive shell prints around it', () => {
    expect(parseShellPath('Welcome!\n__WORK_SHELL_PATH__/a:/b__WORK_SHELL_PATH__\nbye')).toBe('/a:/b');
    expect(parseShellPath('no markers')).toBeNull();
    expect(parseShellPath('__WORK_SHELL_PATH____WORK_SHELL_PATH__')).toBeNull();
  });

  it('asks a login, interactive shell to print $PATH between the markers, and says why when it can not', () => {
    expect(shellPathArgs()).toEqual(['-ilc', `printf '%s%s%s' '__WORK_SHELL_PATH__' "$PATH" '__WORK_SHELL_PATH__'`]);
    const calls: Array<[string, string[]]> = [];
    expect(
      readShellPath('/bin/zsh', (cmd, args) => {
        calls.push([cmd, args]);
        return { stdout: '__WORK_SHELL_PATH__/x__WORK_SHELL_PATH__' };
      }),
    ).toEqual({ path: '/x' });
    expect(calls).toEqual([['/bin/zsh', shellPathArgs()]]);
    expect(readShellPath('/bin/zsh', () => ({ stdout: '', signal: 'SIGKILL' }))).toEqual({
      why: expect.stringContaining('stopped by SIGKILL'),
    });
    expect(readShellPath('/bin/zsh', () => ({ stdout: null, status: 1 }))).toEqual({ why: '/bin/zsh -ilc: exit 1, no PATH printed' });
    expect(readShellPath('/nope', () => ({ error: new Error('spawnSync /nope ENOENT') }))).toEqual({
      why: '/nope -ilc: spawnSync /nope ENOENT',
    });
  });

  it('the shell is killed (SIGKILL: an interactive shell ignores SIGTERM) at the limit, in its own session on POSIX', () => {
    const o = shellPathSpawnOptions() as unknown as Record<string, unknown>;
    expect(o).toMatchObject({ timeout: 5_000, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8' });
    expect(o.detached).toBe(process.platform !== 'win32');
  });

  it.skipIf(process.platform === 'win32')(
    'a shell that ignores SIGTERM and hangs is stopped at the limit (reproduced: 8 s for 2 s before)',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-shell-'));
      try {
        const stuck = path.join(dir, 'stuck-shell');
        fs.writeFileSync(stuck, "#!/bin/sh\ntrap '' TERM\nsleep 20\n", { mode: 0o755 });
        const t = Date.now();
        const r = readShellPath(stuck, (cmd, args) => spawnSync(cmd, args, shellPathSpawnOptions(500)));
        expect(Date.now() - t).toBeLessThan(5_000);
        expect('why' in r).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('merges without repeats, the shell first', () => {
    expect(mergePath(join('/b', '/c'), join('/a', '/b'))).toBe(join('/a', '/b', '/c'));
    expect(mergePath(undefined, '/a')).toBe('/a');
  });
});
