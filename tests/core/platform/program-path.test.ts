import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notOnPath, programPath, whereOnPath } from '../../../src/core/platform/program-path.js';
import { onPathOnly } from '../../../src/core/platform/spawn.js';

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

  it('skips relative PATH entries — they are the working folder again', () => {
    fs.writeFileSync(path.join(bin, 'tool.cmd'), '');
    const rel = path.relative(process.cwd(), bin);
    expect(whereOnPath('tool', env(`.;${rel};\\x`))).toBeNull();
    expect(whereOnPath('tool', env(`.;"${bin}"`))).toBe(path.join(bin, 'tool.cmd'));
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

  it('not on PATH: a path that fails as not found; a name with a path in it is the caller’s', () => {
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
