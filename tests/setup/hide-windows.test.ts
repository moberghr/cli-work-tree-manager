import { describe, expect, it } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { withHide } from './hide-windows.js';
import { shouldHideWindows } from './hide-decision.js';

describe('tests start processes with windowsHide (no console windows flashing on Windows)', () => {
  const cb = () => {};

  it('adds it to the options, or adds options where there are none', () => {
    expect(withHide(['git', ['status'], { cwd: '/r' }])).toEqual(['git', ['status'], { cwd: '/r', windowsHide: true }]);
    expect(withHide(['git status', { encoding: 'utf8' }])).toEqual(['git status', { encoding: 'utf8', windowsHide: true }]);
    expect(withHide(['git', ['status']])).toEqual(['git', ['status'], { windowsHide: true }]);
    expect(withHide(['git status'])).toEqual(['git status', { windowsHide: true }]);
    expect(withHide(['git', ['status'], cb])).toEqual(['git', ['status'], { windowsHide: true }, cb]);
    expect(withHide(['git', { cwd: '/r' }, cb])).toEqual(['git', { cwd: '/r', windowsHide: true }, cb]);
  });

  it("keeps a call's own choice", () => {
    expect(withHide(['git', [], { windowsHide: false }])).toEqual(['git', [], { windowsHide: false }]);
  });

  it('the patched functions still run and answer as before', () => {
    expect(execSync('node -e "process.stdout.write(String(1+1))"', { encoding: 'utf8' })).toBe('2');
    expect(execFileSync(process.execPath, ['-e', 'process.stdout.write("x")'], { encoding: 'utf8' })).toBe('x');
    expect(spawnSync(process.execPath, ['-e', 'process.exit(3)']).status).toBe(3);
  });
});

describe('when the tests hide their processes (hiding costs a console per process where one could be shared)', () => {
  const ask = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, stdoutIsTTY: boolean) =>
    shouldHideWindows({ platform, env, stdoutIsTTY });

  it("Windows with no console to share (an agent's shell or an editor, output piped): hidden", () => {
    expect(ask('win32', {}, false)).toBe(true);
  });

  it("a terminal, CI, or not Windows: not (nothing flashes there, and hiding made CI's git setups time out)", () => {
    expect(ask('win32', {}, true)).toBe(false);
    expect(ask('win32', { CI: 'true' }, false)).toBe(false);
    expect(ask('linux', {}, false)).toBe(false);
  });

  it('WORK_TESTS_HIDE_WINDOWS set by hand wins', () => {
    expect(ask('win32', { CI: 'true', WORK_TESTS_HIDE_WINDOWS: '1' }, true)).toBe(true);
    expect(ask('win32', { WORK_TESTS_HIDE_WINDOWS: '0' }, false)).toBe(false);
  });
});
