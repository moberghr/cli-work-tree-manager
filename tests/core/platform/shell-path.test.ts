import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { agentCommands, ensureShellPath, mergePath, parseShellPath, readShellPath } from '../../../src/core/platform/shell-path.js';

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
      readPath: () => (asked.push('shell'), shell),
      find: finder({ claude: '/Users/m/.local/bin' }),
    });
    expect(r).toBe('added');
    expect(asked).toEqual(['shell']);
    expect(env.PATH).toBe(join('/Users/m/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/Users/m/.work/bin'));
  });

  it('found already (started from a terminal), or on Windows: the shell is never asked', () => {
    const readPath = () => {
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
    expect(ensureShellPath(['claude'], { platform: 'linux', env, readPath: () => null, find: () => null })).toBe('unavailable');
    expect(env.PATH).toBe(dock);
  });

  it('reads the PATH between the markers, whatever an interactive shell prints around it, from `$SHELL -ilc`', () => {
    expect(parseShellPath('Welcome!\n__WORK_SHELL_PATH__/a:/b__WORK_SHELL_PATH__\nbye')).toBe('/a:/b');
    expect(parseShellPath('no markers')).toBeNull();
    expect(parseShellPath('__WORK_SHELL_PATH____WORK_SHELL_PATH__')).toBeNull();
    const calls: Array<[string, string[]]> = [];
    const got = readShellPath('/bin/zsh', (cmd, args) => {
      calls.push([cmd, args]);
      return { stdout: '__WORK_SHELL_PATH__/x__WORK_SHELL_PATH__' };
    });
    expect(got).toBe('/x');
    expect(calls[0][0]).toBe('/bin/zsh');
    expect(calls[0][1][0]).toBe('-ilc');
    expect(readShellPath('/bin/zsh', () => ({ stdout: null }))).toBeNull();
    expect(
      readShellPath('/bin/zsh', () => {
        throw new Error('no shell');
      }),
    ).toBeNull();
  });

  it('merges without repeats, the shell first', () => {
    expect(mergePath(join('/b', '/c'), join('/a', '/b'))).toBe(join('/a', '/b', '/c'));
    expect(mergePath(undefined, '/a')).toBe('/a');
  });

  it("looks for the configured agent's command and claude (the assistant's and the summaries')", () => {
    expect(agentCommands(null)).toEqual(['claude']);
    expect(agentCommands({ aiCommand: 'opencode --x' })).toEqual(['opencode', 'claude']);
  });
});
