import { describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>);
vi.mock('../../../src/core/platform/spawn.js', () => ({
  default: Object.assign(
    (cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawned.push({ cmd, args, opts });
      return { unref: () => {} };
    },
    {
      sync: (cmd: string, args: string[], opts: Record<string, unknown>) => {
        spawned.push({ cmd, args, opts });
        return { status: 0 };
      },
    },
  ),
}));

import { editorArgs, launchAi, openUrl } from '../../../src/core/platform/launch.js';
import { getAiTool } from '../../../src/core/platform/ai-launcher.js';

describe('openUrl', () => {
  it('starts the browser hidden: no console window flashes up first (cmd /c start on Windows)', () => {
    openUrl('http://127.0.0.1:5000/');
    expect(spawned.at(-1)?.opts).toEqual({ stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true });
    expect(spawned.at(-1)?.args.at(-1)).toBe('http://127.0.0.1:5000/');
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
