import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import spawn, { onPathOnly } from '../../../src/core/platform/spawn.js';
import { defaultRunner } from '../../../src/core/platform/command-runner.js';
import { NO_CWD_LOOKUP } from '../../../src/core/platform/shell-env.js';
import { resolvePtyCommand } from '../../../src/core/pty/pty-session.js';

/**
 * A tool installed as a plain batch file (not a Node or Python shim) is run by cmd.exe in the worktree. A bare
 * name inside it must not run a same-named file at the worktree's root — a branch's `probex.bat` — but the one on
 * PATH. Every way work starts a program: the spawn wrapper (launchAi, everything else), the CommandRunner, the PTY.
 */

describe('onPathOnly: a batch file gets cmd.exe’s working-folder lookup turned off', () => {
  it('whatever shape the call has; an .exe and other platforms are left as they are', () => {
    const exe = process.execPath;
    const opts = (r: unknown[]) =>
      r.find((x) => x && typeof x === 'object' && !Array.isArray(x)) as { env?: NodeJS.ProcessEnv } | undefined;
    if (process.platform === 'win32') {
      const bat = path.join(os.tmpdir(), 'some-tool.cmd');
      expect(opts(onPathOnly([bat, ['a'], { cwd: 'C:\\wt' }]))?.env?.[NO_CWD_LOOKUP]).toBe('1');
      expect(opts(onPathOnly([bat, ['a']]))?.env?.[NO_CWD_LOOKUP]).toBe('1');
      const noArgs = onPathOnly([bat, { cwd: 'C:\\wt', env: { A: '1' } }]);
      expect(noArgs[1]).toMatchObject({ cwd: 'C:\\wt', env: { A: '1', [NO_CWD_LOOKUP]: '1' } });
      expect(opts(onPathOnly([exe, ['-v'], { cwd: 'C:\\wt' }]))?.env).toBeUndefined();
    }
    expect(onPathOnly(['x.cmd', ['a'], { cwd: '/wt' }], 'linux')).toEqual(['x.cmd', ['a'], { cwd: '/wt' }]);
  });

  it('keepCwdLookup (an editor, a URL): no switch, the option taken off; a tool run (the same .cmd without it) gets the switch (N4)', () => {
    const bat = path.join(os.tmpdir(), 'some-editor.cmd');
    const editor = onPathOnly([bat, ['.'], { cwd: 'C:/wt', stdio: 'ignore', keepCwdLookup: true }], 'win32');
    expect(editor[2]).toEqual({ cwd: 'C:/wt', stdio: 'ignore' });
    const tool = onPathOnly([bat, ['.'], { cwd: 'C:/wt', stdio: 'ignore' }], 'win32');
    expect((tool[2] as { env?: NodeJS.ProcessEnv }).env?.[NO_CWD_LOOKUP]).toBe('1');
    // A shell command line opting out keeps its environment as given; off Windows the option is still taken off.
    expect(onPathOnly(['code', ['.'], { shell: true, keepCwdLookup: true }], 'win32')[2]).toEqual({ shell: true });
    expect(onPathOnly(['code', ['.'], { keepCwdLookup: true }], 'linux')).toEqual(['code', ['.'], {}]);
  });
});

describe.runIf(process.platform === 'win32')('a batch tool calling a bare name, with that name in the worktree (real cmd.exe)', () => {
  let bin: string;
  let cwd: string;
  // Without the switch, whatever this machine sets for every program (Windows' names are case-blind): the fix must set it.
  let saved: Array<[string, string | undefined]> = [];
  beforeEach(() => {
    saved = Object.keys(process.env)
      .filter((k) => k.toLowerCase() === NO_CWD_LOOKUP.toLowerCase())
      .map((k) => [k, process.env[k]]);
    for (const [k] of saved) delete process.env[k];
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-lookup-bin-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-lookup-cwd-'));
    // The tool, installed as a plain batch file: it calls `probex` by its bare name.
    fs.writeFileSync(path.join(bin, 'batchtool.cmd'), '@call probex\r\n');
    // The one PATH has (what the tool means), and the branch's own at the worktree's root. Echo-only, a marker each.
    fs.writeFileSync(path.join(bin, 'probex.bat'), `@echo PATH> "${path.join(bin, 'path-ran.txt')}"\r\n`);
    fs.writeFileSync(path.join(cwd, 'probex.bat'), '@echo CWD> "%~dp0cwd-ran.txt"\r\n');
  });
  afterEach(() => {
    for (const [k, v] of saved) process.env[k] = v;
    fs.rmSync(bin, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  });
  const env = () => ({ ...process.env, PATH: `${bin};${process.env.PATH ?? ''}` });
  const ranFromCwd = () => fs.existsSync(path.join(cwd, 'cwd-ran.txt'));
  const ranFromPath = () => fs.existsSync(path.join(bin, 'path-ran.txt'));

  it('the spawn wrapper (launchAi and the rest): the worktree’s probex.bat is not run, PATH’s is', () => {
    const r = spawn.sync('batchtool', [], { cwd, env: env(), stdio: 'ignore', timeout: 20_000 });
    expect(r.error).toBeFalsy();
    expect(ranFromCwd()).toBe(false);
    expect(ranFromPath()).toBe(true);
  });

  it('the CommandRunner (git, gh, acli): the same', async () => {
    const tool = path.join(bin, 'batchtool.cmd');
    const r = await defaultRunner(tool, [], cwd, { PATH: env().PATH! });
    expect(r.code).toBe(0);
    expect(ranFromCwd()).toBe(false);
    expect(ranFromPath()).toBe(true);
  });

  it('the PTY: the command it resolves runs cmd.exe with the lookup off (run here as the PTY would)', () => {
    const r = resolvePtyCommand('batchtool', [], { env: env(), cwd });
    expect(path.basename(r.file).toLowerCase()).toBe('cmd.exe');
    expect(r.env?.[NO_CWD_LOOKUP]).toBe('1');
    // The same file, command line and environment node-pty gets, through cmd.exe for real.
    const out = childProcess.spawnSync(r.file, [r.args as string], {
      cwd,
      env: r.env,
      windowsVerbatimArguments: true,
      stdio: 'ignore',
      timeout: 20_000,
      windowsHide: true,
    });
    expect(out.error).toBeFalsy();
    expect(ranFromCwd()).toBe(false);
    expect(ranFromPath()).toBe(true);
  });

  it('without the switch, cmd.exe would have run the worktree’s own (what the fix closes)', () => {
    const plain = env();
    childProcess.spawnSync('cmd.exe', ['/d', '/c', path.join(bin, 'batchtool.cmd')], {
      cwd,
      env: plain,
      stdio: 'ignore',
      timeout: 20_000,
      windowsHide: true,
    });
    expect(ranFromCwd()).toBe(true);
  });
});
