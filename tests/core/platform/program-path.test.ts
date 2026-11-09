import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { explainNotOnPath, notOnPath, programPath, standInFor, whereOnPath } from '../../../src/core/platform/program-path.js';
import { findOnPath, isProgramFile } from '../../../src/core/platform/find-on-path.js';
import { onPathOnly } from '../../../src/core/platform/spawn.js';
import { NO_CWD_LOOKUP } from '../../../src/core/platform/shell-env.js';

describe('programPath off Windows', () => {
  it('leaves the name to the system (a POSIX lookup never takes the working folder unless PATH says so)', () => {
    expect(programPath('git', { PATH: '/usr/bin' }, 'linux')).toBe('git');
    expect(whereOnPath('gh', { PATH: '' }, 'darwin')).toBe('gh');
  });
});

describe.runIf(process.platform === 'win32')('programPath on Windows', () => {
  let bin: string;
  let other: string;
  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-bin-'));
    other = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-other-'));
  });
  afterEach(() => {
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  });
  const env = (p: string) => ({ PATH: p, PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows' });

  it('is the absolute file on PATH, PATHEXT order per folder', () => {
    fs.writeFileSync(path.join(bin, 'tool.cmd'), '');
    fs.writeFileSync(path.join(bin, 'tool.exe'), '');
    expect(programPath('tool', env(bin))).toBe(path.join(bin, 'tool.exe'));
  });

  it('skips relative PATH entries — they are the working folder again (whatever drive the checkout and TEMP are on)', () => {
    fs.writeFileSync(path.join(bin, 'tool.cmd'), '');
    // What was looked at, not where a relative entry happens to land: CI checks out on D: with TEMP on C:.
    const looked: string[] = [];
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      looked.push(String(p));
      return stat(p, o);
    }) as typeof fs.statSync);
    expect(whereOnPath('tool', env(`.;pp-rel-dir;..\\up;\\x;C:rel;${path.basename(bin)}`))).toBeNull();
    expect(looked).toEqual([]);
    expect(whereOnPath('tool', env(`.;pp-rel-dir;"${bin}"`))).toBe(path.join(bin, 'tool.cmd'));
    expect(looked.length).toBeGreaterThan(0);
    expect(looked.every((p) => p.startsWith(bin))).toBe(true);
    vi.restoreAllMocks();
  });

  it('a path is the file Windows would start for it: PATHEXT added to one without an extension, resolved against the start’s folder', () => {
    fs.writeFileSync(path.join(bin, 'agent'), '#!/bin/sh\n'); // npm writes this sh script beside claude.cmd
    fs.writeFileSync(path.join(bin, 'agent.cmd'), '@echo %*\r\n');
    expect(whereOnPath(path.join(bin, 'agent'), env(''))).toBe(path.join(bin, 'agent.cmd'));
    expect(whereOnPath(path.join(bin, 'agent.cmd'), env(''))).toBe(path.join(bin, 'agent.cmd'));
    expect(whereOnPath('.\\agent', env(''), 'win32', bin)).toBe(path.join(bin, 'agent.cmd'));
    expect(programPath(path.join(other, 'agent'), env(''))).toBe(path.join(other, 'agent')); // nothing there: as given
    // The spawn wrapper resolves a path against the call's own cwd, as cross-spawn would.
    expect(onPathOnly(['.\\agent', [], { cwd: bin, env: env('') }])[0]).toBe(path.join(bin, 'agent.cmd'));
  });

  it('a miss is never remembered: a tool installed later is found', () => {
    expect(whereOnPath('later', env(bin))).toBeNull();
    fs.writeFileSync(path.join(bin, 'later.exe'), '');
    expect(whereOnPath('later', env(bin))).toBe(path.join(bin, 'later.exe'));
  });

  it('a remembered hit that went away is looked up again', () => {
    fs.writeFileSync(path.join(bin, 'moved.exe'), '');
    fs.writeFileSync(path.join(other, 'moved.exe'), '');
    const p = `${bin};${other}`;
    expect(whereOnPath('moved', env(p))).toBe(path.join(bin, 'moved.exe'));
    fs.rmSync(path.join(bin, 'moved.exe'));
    expect(whereOnPath('moved', env(p))).toBe(path.join(other, 'moved.exe'));
  });

  it('a program that isn’t on PATH fails as "<name> not found on PATH", never naming the stand-in path', async () => {
    const { default: spawn } = await import('../../../src/core/platform/spawn.js');
    const sync = spawn.sync('work-nothere-xyz', ['--version'], { env: env(bin), windowsHide: true });
    expect(sync.error?.message).toBe('work-nothere-xyz not found on PATH');
    expect((sync.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
    const err = await new Promise<NodeJS.ErrnoException>((resolve) =>
      spawn('work-nothere-xyz', [], { env: env(bin), windowsHide: true }).on('error', resolve),
    );
    expect(err.message).toBe('work-nothere-xyz not found on PATH');
    expect(err.code).toBe('ENOENT');
  });

  it("a shell command line runs with cmd.exe's lookup in the working folder off", () => {
    const [, , opts] = onPathOnly(['tool a', [], { shell: true, cwd: bin, env: env(bin) }]) as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd: string },
    ];
    expect(opts.env[NO_CWD_LOOKUP]).toBe('1');
    expect(opts.env.PATH).toBe(bin);
    expect(opts.cwd).toBe(bin);
    const [, noArgs] = onPathOnly(['tool a', { shell: true }]) as [string, { env: NodeJS.ProcessEnv }];
    expect(noArgs.env[NO_CWD_LOOKUP]).toBe('1');
  });

  it('not on PATH: a path that fails as not found; a path that resolves to nothing is left as given', () => {
    expect(programPath('nothere', env(bin))).toBe(notOnPath('nothere', env(bin)));
    expect(programPath('.\\x.cmd', env(bin))).toBe('.\\x.cmd');
    expect(programPath('C:\\x\\y.exe', env(bin))).toBe('C:\\x\\y.exe');
  });

  it('the spawn wrapper resolves the program with the call’s own env, and leaves a shell command line alone', () => {
    fs.writeFileSync(path.join(bin, 'tool.exe'), '');
    expect(onPathOnly(['tool', ['a'], { env: env(bin) }])).toEqual([path.join(bin, 'tool.exe'), ['a'], { env: env(bin) }]);
    expect(onPathOnly(['tool', { env: env(bin) }])[0]).toBe(path.join(bin, 'tool.exe'));
    expect(onPathOnly(['tool a', [], { shell: true, env: env(bin) }])[0]).toBe('tool a');
  });
});

describe('App Execution Aliases count as installed (stat can’t read them, Windows starts them)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-alias-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** stat answers EACCES for these names, as it does for the stubs in %LOCALAPPDATA%\Microsoft\WindowsApps. */
  const statRefuses = (names: string[]) => {
    const stat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      if (names.includes(path.basename(String(p))))
        throw Object.assign(new Error(`EACCES: permission denied, stat '${String(p)}'`), { code: 'EACCES' });
      return stat(p, o);
    }) as typeof fs.statSync);
  };

  it('on Windows a hit whose stat fails but lstat sees (not a folder) is found; a folder or nothing is not', () => {
    fs.writeFileSync(path.join(dir, 'wt.exe'), '');
    fs.mkdirSync(path.join(dir, 'folder.exe'));
    statRefuses(['wt.exe', 'folder.exe', 'gone.exe']);
    expect(isProgramFile(path.join(dir, 'wt.exe'), 'win32')).toBe(true);
    expect(isProgramFile(path.join(dir, 'folder.exe'), 'win32')).toBe(false);
    expect(isProgramFile(path.join(dir, 'gone.exe'), 'win32')).toBe(false);
    expect(findOnPath('wt', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBe(path.join(dir, 'wt.exe'));
    expect(findOnPath('folder', { PATH: dir, PATHEXT: '.EXE' }, 'win32')).toBeNull();
    // Elsewhere a file stat can't read is no program.
    expect(isProgramFile(path.join(dir, 'wt.exe'), 'linux')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('whereOnPath finds it on PATH (and remembers it), Windows', () => {
    fs.writeFileSync(path.join(dir, 'wt.exe'), '');
    statRefuses(['wt.exe']);
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(whereOnPath('wt.exe', env)).toBe(path.join(dir, 'wt.exe'));
    expect(whereOnPath('wt', env)).toBe(path.join(dir, 'wt.exe'));
    expect(whereOnPath('wt.exe', env)).toBe(path.join(dir, 'wt.exe')); // the remembered hit is checked the same way
  });

  // The real thing, where this Windows has one: Windows Terminal's or winget's alias.
  const apps = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '';
  const realAlias = ['wt.exe', 'winget.exe'].find((n) => {
    try {
      return process.platform === 'win32' && apps !== '' && !fs.lstatSync(path.join(apps, n)).isDirectory();
    } catch {
      return false;
    }
  });
  it.runIf(realAlias !== undefined)('a real alias in WindowsApps is found, not taken for missing', () => {
    expect(whereOnPath(realAlias!, { PATH: apps, PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toBe(path.join(apps, realAlias!));
  });
});

describe('the stand-in for a missing program never shows', () => {
  it('an error from it is said in the program’s own name, its code kept', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    expect(standInFor(notOnPath('winget', env))).toBe('winget');
    expect(standInFor('C:\\tools\\winget.exe')).toBeNull();
    const err = Object.assign(new Error(`spawn ${notOnPath('winget', env)} ENOENT`), { code: 'ENOENT', path: notOnPath('winget', env) });
    expect(explainNotOnPath(err).message).toBe('winget not found on PATH');
    expect(err.code).toBe('ENOENT');
    expect(err.path).toBe('winget');
    // From the message alone (cross-spawn's own ENOENT), and nothing else touched.
    expect(explainNotOnPath(new Error(`spawnSync ${notOnPath('gh', env)} ENOENT`)).message).toBe('gh not found on PATH');
    expect(explainNotOnPath(new Error('spawn git EACCES')).message).toBe('spawn git EACCES');
    expect(explainNotOnPath('x')).toBe('x');
  });
});
