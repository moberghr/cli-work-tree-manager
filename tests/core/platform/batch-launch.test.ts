import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchArgProblem, launchFor, nodeShimOf, programFor, pythonShimOf } from '../../../src/core/platform/batch-launch.js';
import { notOnPath } from '../../../src/core/platform/program-path.js';
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
    expect(launchFor('tool', ['list', 'feat/x'], io('C:\\bin\\tool.cmd', '@echo %*'))).toEqual({
      cmd: 'C:\\bin\\tool.cmd',
      args: ['list', 'feat/x'],
    });
  });

  it('an .exe runs by its full path on PATH; anything off Windows as given', () => {
    const args = ['pr', 'view', 'a"&b'];
    expect(launchFor('gh', args, io('C:\\bin\\gh.exe', null))).toEqual({ cmd: 'C:\\bin\\gh.exe', args });
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

/** npm's own shim for a global package's bin (cmd-shim), as `npm i -g @anthropic-ai/claude-code` writes claude.cmd. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

describe('a Node script behind a batch file (npm shims) is started without it', () => {
  it("reads npm's shim: the script and the node.exe it would prefer", () => {
    expect(nodeShimOf(NPM_SHIM, 'C:\\npm\\claude.cmd')).toEqual({
      script: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      localNode: 'C:\\npm\\node.exe',
    });
    expect(nodeShimOf('@echo off\r\nnode "%~dp0echo-ai.cjs" %*', 'C:\\t\\echo-ai.cmd')?.script).toBe('C:\\t\\echo-ai.cjs');
  });

  it('is not fooled by a script another program runs, or a batch file with no script', () => {
    expect(nodeShimOf('@echo off\r\nwscript "%~dp0\\x.js" %*', 'C:\\x\\t.cmd')).toBeNull();
    expect(nodeShimOf('@echo %*', 'C:\\x\\t.cmd')).toBeNull();
    expect(nodeShimOf(AZ_CMD, 'C:\\x\\az.cmd')).toBeNull();
  });

  const io = (found: Record<string, string>, text: string, existing: string[]) => ({
    platform: 'win32' as const,
    env: { PATH: 'C:\\npm;C:\\node' },
    find: (c: string) => found[c] ?? null,
    read: () => text,
    exists: (f: string) => existing.includes(f),
  });
  const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';

  it("runs the shim's own node.exe on the script, else node from PATH — every argument as argv", () => {
    const args = ['--continue', 'line1\nline2 "&echo X&" %PATH%'];
    expect(launchFor('claude', args, io({ claude: 'C:\\npm\\claude.cmd' }, NPM_SHIM, [script, 'C:\\npm\\node.exe']))).toEqual({
      cmd: 'C:\\npm\\node.exe',
      args: [script, ...args],
    });
    expect(programFor('claude', io({ claude: 'C:\\npm\\claude.cmd' }, NPM_SHIM, [script]))?.pre).toEqual([script]);
  });

  it('a shim whose script is gone stays a batch file', () => {
    expect(programFor('claude', io({ claude: 'C:\\npm\\claude.cmd' }, NPM_SHIM, []))).toEqual({
      file: 'C:\\npm\\claude.cmd',
      pre: [],
      batch: true,
    });
  });

  it('a program PATH lacks starts nowhere: a path that fails as not found, never the bare name', () => {
    expect(programFor('git', io({}, '', []))).toBeNull();
    const env = { PATH: 'C:\\npm', SystemRoot: 'C:\\Windows' };
    expect(launchFor('git', ['status'], { platform: 'win32', env, find: () => null })).toEqual({
      cmd: notOnPath('git', env),
      args: ['status'],
    });
    expect(notOnPath('git', env)).toBe('C:\\Windows\\work-not-on-path\\git');
  });
});

// The working folder never wins over PATH: a `probetool.cmd` in the cwd that writes a marker, beside the real one on
// PATH. Before, cross-spawn's lookup (node-which, cwd first) ran the cwd's.
describe.runIf(process.platform === 'win32')('the runner never starts a program from the working folder (Windows)', () => {
  let onPath: string;
  let repo: string;
  let oldPath: string | undefined;
  beforeAll(() => {
    onPath = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-path-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-repo-'));
    fs.writeFileSync(path.join(onPath, 'probetool.cmd'), '@echo FROM-PATH %*\r\n');
    fs.writeFileSync(path.join(repo, 'probetool.cmd'), '@echo FROM-REPO > "%~dp0marker.txt"\r\n@echo FROM-REPO\r\n');
    fs.writeFileSync(path.join(repo, 'lonelytool.cmd'), '@echo LONELY > "%~dp0marker.txt"\r\n');
    oldPath = process.env.PATH;
    process.env.PATH = `${onPath};.;${oldPath ?? ''}`;
  });
  afterAll(() => {
    process.env.PATH = oldPath;
    fs.rmSync(onPath, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("runs PATH's, not the worktree's, even with '.' on PATH", async () => {
    const r = await defaultRunner('probetool', ['plain'], repo);
    expect(r.stdout).toMatch(/FROM-PATH "?plain/);
    expect(r.stdout).not.toContain('FROM-REPO');
    expect(fs.existsSync(path.join(repo, 'marker.txt'))).toBe(false);
  });

  it('a program only the working folder has is "not installed" (127), and nothing runs', async () => {
    const r = await defaultRunner('lonelytool', [], repo);
    expect(r.code).toBe(127);
    expect(fs.existsSync(path.join(repo, 'marker.txt'))).toBe(false);
  });

  it('the shared spawn wrapper resolves the same way (sync and async)', async () => {
    const { default: spawn } = await import('../../../src/core/platform/spawn.js');
    const r = spawn.sync('probetool', ['x'], { cwd: repo, encoding: 'utf8', windowsHide: true });
    expect(String(r.stdout)).toMatch(/FROM-PATH "?x/);
    const lonely = spawn.sync('lonelytool', [], { cwd: repo, encoding: 'utf8', windowsHide: true });
    expect(lonely.status).not.toBe(0);
    expect(fs.existsSync(path.join(repo, 'marker.txt'))).toBe(false);
  });
});

// Batch-ness is judged on the file that really starts. A Node shim's `node` can itself be a batch file (a version
// manager's node.cmd first on PATH), and an extension-less path (`C:\npm\claude`, `where`'s first line) starts the
// .cmd beside it.
describe('batch-ness of the file that really starts', () => {
  const script = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const io = (found: Record<string, string>, execPath: string, existing: string[] = [script]) => ({
    platform: 'win32' as const,
    env: { PATH: 'C:\\vm;C:\\npm' },
    find: (c: string) => found[c] ?? null,
    read: () => NPM_SHIM,
    exists: (f: string) => existing.includes(f),
    execPath,
  });

  it("a shim whose node on PATH is a batch file runs on work's own node.exe instead — the prompt stays argv", () => {
    const args = ['--continue', 'x"&echo INJECTED&"'];
    const found = { claude: 'C:\\npm\\claude.cmd', node: 'C:\\vm\\node.cmd' };
    expect(launchFor('claude', args, io(found, 'C:\\Program Files\\nodejs\\node.exe'))).toEqual({
      cmd: 'C:\\Program Files\\nodejs\\node.exe',
      args: [script, ...args],
    });
    // A real node.exe on PATH is the one the shim would run: kept.
    expect(programFor('claude', io({ ...found, node: 'C:\\node\\node.exe' }, 'C:\\other\\node.exe'))?.file).toBe('C:\\node\\node.exe');
  });

  it('with no real node to run it on, the shim is the batch file it is: unsafe arguments refused', () => {
    const found = { claude: 'C:\\npm\\claude.cmd', node: 'C:\\vm\\node.bat' };
    expect(programFor('claude', io(found, 'C:\\vm\\node.cmd'))).toEqual({ file: 'C:\\npm\\claude.cmd', pre: [], batch: true });
    expect(launchFor('claude', ['x"&echo INJECTED&"'], io(found, '/usr/bin/node'))).toEqual({
      refused: `claude: refused: an argument has """, which a Windows batch file can't be given safely`,
    });
  });

  it('a path is looked up as the file it starts, and judged on that', () => {
    const seen: (string | undefined)[] = [];
    const r = programFor('C:\\npm\\claude', {
      env: {},
      find: (c, _e, _p, cwd) => {
        seen.push(cwd);
        return c === 'C:\\npm\\claude' ? 'C:\\npm\\claude.cmd' : null;
      },
      read: () => '@echo %*',
      cwd: 'C:\\work',
    });
    expect(r).toEqual({ file: 'C:\\npm\\claude.cmd', pre: [], batch: true });
    expect(seen).toEqual(['C:\\work']);
  });
});

// The reviewer's probes, for real (Windows, echo-only files): each printed INJECTED before the fix.
describe.runIf(process.platform === 'win32')('the injections that went through, now refused or harmless (Windows)', () => {
  let root: string;
  let vm: string;
  let npm: string;
  let ext: string;
  const prompt = 'PAY-1 x"&echo INJECTED&"';
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-class-'));
    vm = path.join(root, 'vm');
    npm = path.join(root, 'npm');
    ext = path.join(root, 'ext');
    fs.mkdirSync(path.join(npm, 'node_modules', 'fake'), { recursive: true });
    fs.mkdirSync(vm);
    fs.mkdirSync(ext);
    // A version manager's node.cmd that would echo whatever cmd.exe makes of its arguments.
    fs.writeFileSync(path.join(vm, 'node.cmd'), '@echo NODECMD %*\r\n');
    fs.writeFileSync(path.join(npm, 'node_modules', 'fake', 'cli.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    fs.writeFileSync(path.join(npm, 'fakeagent.cmd'), NPM_SHIM.replace('@anthropic-ai\\claude-code', 'fake'));
    // npm writes an extension-less sh script beside each .cmd; `where` prints it first.
    fs.writeFileSync(path.join(ext, 'agent'), '#!/bin/sh\n');
    fs.writeFileSync(path.join(ext, 'agent.cmd'), '@echo ARGS:%*\r\n');
  });
  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it("npm's shim with a node.cmd first on PATH: started on a real node, the prompt one argument", async () => {
    const env = { ...process.env, PATH: `${vm};${npm};${process.env.PATH ?? ''}` };
    const launch = launchFor('fakeagent', [prompt], { env });
    expect(launch).toEqual({ cmd: process.execPath, args: [path.join(npm, 'node_modules', 'fake', 'cli.js'), prompt] });
    const { default: spawn } = await import('../../../src/core/platform/spawn.js');
    if ('refused' in launch) throw new Error(launch.refused);
    const r = spawn.sync(launch.cmd, launch.args, { env, encoding: 'utf8', windowsHide: true });
    expect(JSON.parse(String(r.stdout))).toEqual([prompt]);
    expect(String(r.stdout)).not.toContain('NODECMD');
  });

  it('an extension-less path to a .cmd: refused such a prompt, given a plain one', async () => {
    expect(launchFor(path.join(ext, 'agent'), [prompt])).toEqual({
      refused: `${path.join(ext, 'agent')}: refused: an argument has """, which a Windows batch file can't be given safely`,
    });
    const plain = launchFor(path.join(ext, 'agent'), ['fix', 'it']);
    expect(plain).toEqual({ cmd: path.join(ext, 'agent.cmd'), args: ['fix', 'it'] });
    const { default: spawn } = await import('../../../src/core/platform/spawn.js');
    if ('refused' in plain) throw new Error(plain.refused);
    expect(String(spawn.sync(plain.cmd, plain.args, { encoding: 'utf8', windowsHide: true }).stdout).trim()).toBe('ARGS:"fix" "it"');
  });
});
