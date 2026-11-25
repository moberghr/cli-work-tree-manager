import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>);
// Every child the mocked spawn returned: an EventEmitter with `unref`, so a test can make it fail, exit or spawn.
const children = vi.hoisted(() => [] as Array<import('node:events').EventEmitter & { unref: () => void }>);
vi.mock('../../../src/core/platform/spawn.js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    default: Object.assign(
      (cmd: string, args: string[], opts: Record<string, unknown>) => {
        spawned.push({ cmd, args, opts });
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        children.push(child);
        return child;
      },
      {
        sync: (cmd: string, args: string[], opts: Record<string, unknown>) => {
          spawned.push({ cmd, args, opts });
          return { status: 0 };
        },
      },
    ),
  };
});

import {
  defaultAppCommand,
  editorArgs,
  launchAi,
  openInEditor,
  openUrl,
  openVSCode,
  openWithDefaultApp,
  revealCommand,
  revealInFileManager,
  startEditor,
} from '../../../src/core/platform/launch.js';
import { saveConfig, type WorkConfig } from '../../../src/core/platform/config.js';
import { getAiTool } from '../../../src/core/platform/ai-launcher.js';

describe('openUrl', () => {
  it('starts the browser hidden: no console window flashes up first (cmd /c start on Windows)', () => {
    openUrl('http://127.0.0.1:5000/');
    expect(spawned.at(-1)?.opts).toEqual({
      stdio: 'ignore',
      detached: process.platform !== 'win32',
      windowsHide: true,
      keepCwdLookup: true,
    });
    expect(spawned.at(-1)?.args.at(-1)).toBe('http://127.0.0.1:5000/');
  });
});

describe("keepCwdLookup: what you work in keeps cmd.exe's usual lookup; a tool run doesn't (N4)", () => {
  it('the editor, VS Code and the browser pass it; launchAi (a tool run) does not', () => {
    openInEditor('/x/config.json');
    expect(spawned.at(-1)?.opts).toMatchObject({ keepCwdLookup: true });
    openVSCode('/wt/api');
    expect(spawned.at(-1)?.opts).toMatchObject({ keepCwdLookup: true });
    openUrl('http://127.0.0.1:5000/');
    expect(spawned.at(-1)?.opts).toMatchObject({ keepCwdLookup: true });
    launchAi('/wt/api', getAiTool({}));
    expect(spawned.at(-1)?.opts).not.toHaveProperty('keepCwdLookup');
  });
});

describe('editorArgs', () => {
  const folder = '/wt/api';
  const file = { path: '/wt/api/src/cart.ts', line: 42 };

  it('no file: the folder, as the session menu always did', () => {
    expect(editorArgs('code', folder)).toEqual([folder]);
    expect(editorArgs('notepad', folder)).toEqual([folder]);
  });

  it("VS Code and its kin: the folder's window, the file at its line", () => {
    expect(editorArgs('code', folder, file)).toEqual([folder, '--goto', '/wt/api/src/cart.ts:42']);
    expect(editorArgs('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', folder, file)).toEqual([
      folder,
      '--goto',
      '/wt/api/src/cart.ts:42',
    ]);
    expect(editorArgs('cursor', folder, file)[1]).toBe('--goto');
    expect(editorArgs('code-insiders', folder, { path: file.path })).toEqual([folder, '--goto', file.path]); // no line
  });

  it('JetBrains and Sublime take a line their own way', () => {
    expect(editorArgs('rider64.exe', folder, file)).toEqual([folder, '--line', '42', file.path]);
    expect(editorArgs('idea', folder, { path: file.path })).toEqual([folder, file.path]);
    expect(editorArgs('subl', folder, file)).toEqual([folder, '/wt/api/src/cart.ts:42']);
  });

  it('an editor it does not know gets the file alone, never a made-up line flag', () => {
    expect(editorArgs('notepad', folder, file)).toEqual([file.path]);
    expect(editorArgs('vim', folder, file)).toEqual([file.path]);
  });
});

describe('defaultAppCommand: the system opens a file with its own app', () => {
  it('open on macOS, explorer.exe on Windows, xdg-open elsewhere, the path as the one argument', () => {
    expect(defaultAppCommand('/tmp/mock up.html', 'darwin')).toEqual({ cmd: 'open', args: ['/tmp/mock up.html'] });
    expect(defaultAppCommand('C:\\Users\\me\\mock up.html', 'win32')).toEqual({
      cmd: 'explorer.exe',
      args: ['C:\\Users\\me\\mock up.html'],
    });
    expect(defaultAppCommand('/tmp/mock up.html', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/tmp/mock up.html'] });
  });
});

describe('revealCommand: shown in the file manager, never opened', () => {
  it('Finder selects it (open -R)', () => {
    expect(revealCommand('/Applications/Thing.app', 'darwin')).toEqual({ cmd: 'open', args: ['-R', '/Applications/Thing.app'] });
  });

  it('Explorer selects it: `/select,<path>` is ONE argument', () => {
    const r = revealCommand('C:\\work\\my repo\\run.cmd', 'win32');
    expect(r).toEqual({ cmd: 'explorer.exe', args: ['/select,C:\\work\\my repo\\run.cmd'] });
    expect(r.args).toHaveLength(1);
  });

  it('elsewhere its folder is opened (no common way to select a file)', () => {
    expect(revealCommand('/home/me/src/run.sh', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/home/me/src'] });
  });
});

describe('launchAi: the environment it starts the agent with (T1)', () => {
  const tool = getAiTool({});
  const envOf = () => spawned.at(-1)!.opts.env as Record<string, string | undefined> | undefined;
  const KEY = 'WORK_TEST_LAUNCH_VAR';

  it('no change and no port: no env given at all (this terminal’s, as before accounts)', () => {
    launchAi('/wt/api', tool);
    expect(spawned.at(-1)!.opts).toEqual({ cwd: '/wt/api', stdio: 'inherit', windowsHide: false });
    launchAi('/wt/api', tool, {}, undefined, {});
    expect(envOf()).toBeUndefined();
  });

  it('a null in the change takes an inherited variable out', () => {
    process.env[KEY] = 'inherited';
    try {
      launchAi('/wt/api', tool, {}, undefined, { [KEY]: null });
      expect(envOf()).toBeDefined();
      expect(KEY in envOf()!).toBe(false);
      expect(envOf()!.PATH ?? envOf()!.Path).toBe(process.env.PATH ?? process.env.Path); // the rest is this terminal's
    } finally {
      delete process.env[KEY];
    }
  });

  it('a string sets it; with a port, both', () => {
    launchAi('/wt/api', tool, {}, undefined, { [KEY]: '/acc' });
    expect(envOf()![KEY]).toBe('/acc');
    expect(envOf()!.PORT).toBeUndefined();
    launchAi('/wt/api', tool, {}, 5123, { [KEY]: '/acc' });
    expect(envOf()![KEY]).toBe('/acc');
    expect(envOf()!.PORT).toBe('5123');
    launchAi('/wt/api', tool, {}, 5124);
    expect(envOf()!.PORT).toBe('5124');
    expect(KEY in envOf()!).toBe(false);
  });
});

describe('launchAi: a prompt never reaches cmd.exe (--no-host)', () => {
  const SHIM = path.resolve(__dirname, '../../functional/fixtures/echo-ai.cmd');
  const prompt = 'fix "it" & echo INJECTED\nsecond line %PATH%';

  it.runIf(process.platform === 'win32')("a Node shim (npm's claude.cmd) is skipped: node on its script, the prompt as argv", () => {
    launchAi('C:\\wt', { ...getAiTool({}), cmd: SHIM }, { initialPrompt: prompt });
    expect(path.basename(spawned.at(-1)!.cmd).toLowerCase()).toBe('node.exe');
    expect(spawned.at(-1)!.args).toEqual([path.resolve(__dirname, '../../functional/fixtures/echo-ai.cjs'), prompt]);
  });

  it.runIf(process.platform === 'win32')('another batch file is refused the prompt, and nothing starts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-ai-'));
    try {
      const bat = path.join(dir, 'agent.cmd');
      fs.writeFileSync(bat, '@echo %*\r\n');
      const before = spawned.length;
      expect(() => launchAi(dir, { ...getAiTool({}), cmd: bat }, { initialPrompt: prompt })).toThrow(/refused: an argument has/);
      expect(spawned.length).toBe(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('elsewhere the tool and its prompt go as given', () => {
    launchAi('/wt', getAiTool({}), { initialPrompt: prompt });
    expect(spawned.at(-1)!.cmd).toBe('claude');
    expect(spawned.at(-1)!.args.at(-1)).toBe(prompt);
  });
});

describe('the openers: the default app and the file manager', () => {
  afterEach(() => vi.useRealTimers());

  const lastChild = () => children.at(-1)!;
  const tells = () => defaultAppCommand('/x/a.html').cmd !== 'explorer.exe'; // does this platform's opener say a failure by its exit?

  it("openWithDefaultApp starts this platform's default-app command, hidden, with no stdio", () => {
    void openWithDefaultApp('/x/a.html');
    const { cmd, args } = defaultAppCommand('/x/a.html');
    expect(spawned.at(-1)).toMatchObject({ cmd, args, opts: { windowsHide: true, stdio: 'ignore' } });
  });

  it('revealInFileManager starts the reveal command', () => {
    void revealInFileManager('/x/a.html');
    const { cmd, args } = revealCommand('/x/a.html');
    expect(spawned.at(-1)).toMatchObject({ cmd, args, opts: { windowsHide: true, stdio: 'ignore' } });
  });

  it('a program that cannot start says so, with the reason', async () => {
    const p = openWithDefaultApp('/x/a.html');
    lastChild().emit('error', new Error('ENOENT'));
    expect(await p).toBe(`could not start ${defaultAppCommand('/x/a.html').cmd}: ENOENT`);
  });

  it.runIf(process.platform !== 'win32')('open / xdg-open: a non-zero exit is a failure, a zero exit is not', async () => {
    const cmd = defaultAppCommand('/x/a.html').cmd;
    const failed = openWithDefaultApp('/x/a.html');
    lastChild().emit('exit', 1);
    expect(await failed).toBe(`${cmd} failed (exit code 1)`);
    const ok = openWithDefaultApp('/x/a.html');
    lastChild().emit('exit', 0);
    expect(await ok).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('open / xdg-open: nothing said within 500 ms counts as running', async () => {
    vi.useFakeTimers();
    const p = openWithDefaultApp('/x/a.html');
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeNull();
  });

  it.runIf(process.platform === 'win32')('explorer.exe: started is enough, and a non-zero exit is no failure', async () => {
    expect(tells()).toBe(false);
    const started = openWithDefaultApp('C:\\x\\a.html');
    lastChild().emit('spawn');
    expect(await started).toBeNull();
    const exited = openWithDefaultApp('C:\\x\\a.html');
    lastChild().emit('exit', 1);
    expect(await exited).toBeNull();
  });
});

describe('startEditor: which program', () => {
  afterEach(() => saveConfig({} as WorkConfig));

  it('the configured editor', async () => {
    saveConfig({ editor: 'cursor' } as WorkConfig);
    const p = startEditor('/wt/api');
    expect(spawned.at(-1)).toMatchObject({ cmd: 'cursor', args: ['/wt/api'] });
    children.at(-1)!.emit('exit', 0);
    expect(await p).toBeNull();
  });

  it('code when none is configured; a failure names the editor', async () => {
    saveConfig({} as WorkConfig);
    const p = startEditor('/wt/api', { path: '/wt/api/a.ts', line: 3 });
    expect(spawned.at(-1)).toMatchObject({ cmd: 'code', args: ['/wt/api', '--goto', '/wt/api/a.ts:3'] });
    children.at(-1)!.emit('error', new Error('spawn code ENOENT'));
    expect(await p).toBe('could not start code: spawn code ENOENT');
  });
});
