import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_CWD_LOOKUP, shellEnv } from '../../../src/core/platform/shell-env.js';

describe('shellEnv: a shell never takes a program from the working folder (Windows)', () => {
  it('on Windows sets NoDefaultCurrentDirectoryInExePath, replacing any other spelling of it, and keeps the rest', () => {
    const env = shellEnv({ PATH: 'C:\\bin', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0', WORK_SESSION: 's' }, 'win32');
    expect(env).toEqual({ PATH: 'C:\\bin', WORK_SESSION: 's', [NO_CWD_LOOKUP]: '1' });
  });

  it('elsewhere the environment is as given', () => {
    const given = { PATH: '/usr/bin' };
    expect(shellEnv(given, 'linux')).toBe(given);
    expect(shellEnv(given, 'darwin')).toBe(given);
  });
});

// The real thing: a `probex.bat` committed at a branch's root. Without the variable cmd.exe ran it for a bare
// `probex`; with it, the bare name isn't found, and the same script by its path still runs (what a dev command
// that means the branch's own script does).
describe.runIf(process.platform === 'win32')('cmd.exe with shellEnv, for real (Windows, echo-only file)', () => {
  let cwd: string;
  beforeAll(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-env-'));
    fs.writeFileSync(path.join(cwd, 'probex.bat'), '@echo FROM-CWD\r\n');
  });
  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const run = (cmd: string, env: NodeJS.ProcessEnv) =>
    spawnSync(cmd, { cwd, env, shell: true, encoding: 'utf8', windowsHide: true }).stdout.trim();
  const without = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== NO_CWD_LOOKUP.toLowerCase()));

  it('a bare name no longer runs the working folder’s file; a path to it does', () => {
    expect(run('probex', without())).toBe('FROM-CWD'); // the hole, as it was
    expect(run('probex', shellEnv(without()))).toBe('');
    expect(run('.\\probex', shellEnv(without()))).toBe('FROM-CWD');
  });

  it('the spawn wrapper sets it for a shell: true start', async () => {
    const { default: spawn } = await import('../../../src/core/platform/spawn.js');
    const r = spawn.sync('probex', [], { cwd, env: without(), shell: true, encoding: 'utf8', windowsHide: true });
    expect(String(r.stdout)).not.toContain('FROM-CWD');
  });
});
