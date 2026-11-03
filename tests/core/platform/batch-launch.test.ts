import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchArgProblem, launchFor, pythonShimOf } from '../../../src/core/platform/batch-launch.js';
import { defaultRunner } from '../../../src/core/platform/command-runner.js';

/** The Azure CLI's own `az.cmd`, as its Windows installer writes it. */
const AZ_CMD = [
  '::',
  ':: Microsoft Azure CLI - Windows Installer - Author file components script',
  '::',
  '',
  '@IF EXIST "%~dp0\\..\\python.exe" (',
  '  SET AZ_INSTALLER=MSI',
  '  "%~dp0\\..\\python.exe" -IBm azure.cli %*',
  ') ELSE (',
  '  echo Failed to load python executable.',
  '  exit /b 1',
  ')',
].join('\r\n');

describe('arguments a Windows batch file may be given', () => {
  it.each([
    ['feat/x"&echo INJECTED&"'],
    ['Support "a | b" & more'],
    ['line1\nline2'],
    ['%PATH%'],
    ['a^b'],
    ['a>b'],
    ['a(b)'],
    ['a!b'],
    ['a\rb'],
  ])('refuses %j', (arg) => {
    expect(batchArgProblem(['repos', arg])).toMatch(/^refused: an argument has .+, which a Windows batch file can't be given safely$/);
  });

  it('lets plain ones through: names, branches, URLs, paths, numbers', () => {
    expect(
      batchArgProblem([
        'repos',
        'pr',
        'list',
        '--org',
        'https://dev.azure.com/acme',
        'feat/x-1',
        'My Shop',
        'C:\\tmp\\body.json',
        '42',
        'a=b',
      ]),
    ).toBeNull();
  });
});

describe('a Python CLI behind a batch file is started without it', () => {
  it("reads az.cmd's Python and module", () => {
    const shim = pythonShimOf(AZ_CMD, 'C:\\Program Files\\Azure\\CLI2\\wbin\\az.cmd');
    expect(shim).toEqual({ cmd: path.resolve('C:\\Program Files\\Azure\\CLI2\\wbin', '..\\python.exe'), pre: ['-IBm', 'azure.cli'] });
    expect(pythonShimOf('@echo off\r\nnode "%~dp0\\cli.js" %*', 'C:\\x\\tool.cmd')).toBeNull();
  });

  const io = (file: string | null, text: string | null, exists = true) => ({
    platform: 'win32' as const,
    env: { PATH: 'C:\\bin' },
    find: () => file,
    read: () => text,
    exists: () => exists,
  });

  it('on Windows: az.cmd becomes its Python with every argument as argv — a quote, a line break, a % stay text', () => {
    const args = ['repos', 'pr', 'list', '--source-branch', 'feat/x"&echo no&"', '--title', 'a\nb %PATH%'];
    expect(launchFor('az', args, io('C:\\az\\wbin\\az.cmd', AZ_CMD))).toEqual({
      cmd: path.resolve('C:\\az\\wbin', '..\\python.exe'),
      args: ['-IBm', 'azure.cli', ...args],
    });
  });

  it('another batch file (or az.cmd whose Python is gone) is refused such arguments, and given plain ones', () => {
    expect(launchFor('az', ['x"&calc'], io('C:\\az\\wbin\\az.cmd', AZ_CMD, false))).toEqual({
      refused: `az: refused: an argument has """, which a Windows batch file can't be given safely`,
    });
    expect(launchFor('tool', ['list', 'feat/x'], io('C:\\bin\\tool.cmd', '@echo %*'))).toEqual({ cmd: 'tool', args: ['list', 'feat/x'] });
  });

  it('an .exe, or anything off Windows, runs as given', () => {
    const args = ['pr', 'view', 'a"&b'];
    expect(launchFor('gh', args, io('C:\\bin\\gh.exe', null))).toEqual({ cmd: 'gh', args });
    expect(launchFor('az', args, { ...io('/usr/bin/az', null), platform: 'linux' })).toEqual({ cmd: 'az', args });
  });
});

// The real thing, on Windows: an `echo`-only batch file on PATH, run through work's own runner. Before the fix
// the argument `feat/x"&echo INJECTED&"` ran the echo (the review's probe); now it is refused before cmd.exe starts.
describe.runIf(process.platform === 'win32')('the runner and a real batch file (Windows)', () => {
  let dir: string;
  let oldPath: string | undefined;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-probe-'));
    fs.writeFileSync(path.join(dir, 'probetool.cmd'), '@IF 1==1 (\r\n  echo ARGS: %*\r\n)\r\n');
    oldPath = process.env.PATH;
    process.env.PATH = `${dir};${oldPath ?? ''}`;
  });
  afterAll(() => {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an argument that would run a command of its own; runs plain ones', async () => {
    const bad = await defaultRunner('probetool', ['repos', '--source-branch', 'feat/x"&echo INJECTED&"'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stdout).not.toContain('INJECTED');
    expect(bad.stderr).toMatch(/refused/);
    const multi = await defaultRunner('probetool', ['--description', 'line1\nline2', '--draft', 'true'], dir);
    expect(multi.code).toBe(1);
    const ok = await defaultRunner('probetool', ['repos', 'pr', 'list', '--org', 'https://dev.azure.com/acme'], dir);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('https://dev.azure.com/acme');
  });
});
