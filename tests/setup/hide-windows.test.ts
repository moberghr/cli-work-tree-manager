import { describe, expect, it } from 'vitest';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { withHide } from './hide-windows.js';

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
