import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isPidAlive } from '../../../../src/core/platform/process.js';
import { isOurs, originalStatusLine, runStatusLineCommand, shellFor } from '../../../../src/core/agents/claude/statusline-run.js';

const savedFile = () => path.join(os.homedir(), '.work', 'statusline.json');

/** Poll until `cond` holds or `ms` pass. */
async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

// One HOME per file: each test starts with nothing saved.
beforeEach(() => fs.rmSync(savedFile(), { force: true }));

describe('isOurs', () => {
  it("knows work's hook under any path, with the user's line as its fallback too", () => {
    expect(isOurs({ type: 'command', command: 'work hook statusline' })).toBe(true);
    expect(isOurs({ type: 'command', command: 'node /x/dist/bin.js hook statusline' })).toBe(true);
    expect(isOurs({ type: 'command', command: 'work hook statusline || (echo mine)' })).toBe(true);
    expect(isOurs({ type: 'command', command: 'work hook statusline || (echo # x\n)' })).toBe(true);
    expect(isOurs({ type: 'command', command: 'echo mine' })).toBe(false);
    expect(isOurs(null)).toBe(false);
  });
});

describe('originalStatusLine', () => {
  const save = (text: string) => {
    fs.mkdirSync(path.dirname(savedFile()), { recursive: true });
    fs.writeFileSync(savedFile(), text);
  };
  it('is null for nothing saved, damage and a command-less original', () => {
    expect(originalStatusLine()).toBeNull();
    save('{nope');
    expect(originalStatusLine()).toBeNull();
    save(JSON.stringify({ original: 'echo' }));
    expect(originalStatusLine()).toBeNull();
    save(JSON.stringify({ original: { type: 'command', command: 5 } }));
    expect(originalStatusLine()).toBeNull();
    save(JSON.stringify({ original: { type: 'command', command: 'echo ok' } }));
    expect(originalStatusLine()).toEqual({ command: 'echo ok' });
  });

  it('tells why a saved file is unreadable, and nothing when there is none', () => {
    const why: string[] = [];
    expect(originalStatusLine((w) => why.push(w))).toBeNull();
    expect(why).toEqual([]);
    save('{nope');
    expect(originalStatusLine((w) => why.push(w))).toBeNull();
    expect(why).toHaveLength(1);
  });
});

describe('shellFor', () => {
  it('is sh on POSIX', () => {
    const sh = shellFor('linux', {});
    expect(sh.file).toBe('/bin/sh');
    expect(sh.args('echo 1')).toEqual(['-c', 'echo 1']);
  });

  it('uses CLAUDE_CODE_GIT_BASH_PATH when it exists, else looks beside git.exe', () => {
    const has = new Set(['D:\\custom\\bash.exe']);
    expect(shellFor('win32', { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\custom\\bash.exe' }, (p) => has.has(p)).file).toBe('D:\\custom\\bash.exe');

    const git = new Set(['C:\\Git\\cmd\\git.exe', path.win32.join('C:\\Git\\cmd', '..', 'bin', 'bash.exe')]);
    expect(shellFor('win32', { CLAUDE_CODE_GIT_BASH_PATH: 'Z:\\gone.exe', PATH: 'C:\\x;C:\\Git\\cmd' }, (p) => git.has(p)).file).toBe(
      path.win32.join('C:\\Git\\cmd', '..', 'bin', 'bash.exe'),
    );
  });

  it('falls back to the standard Git folder, then bash', () => {
    const std = 'C:\\Program Files\\Git\\bin\\bash.exe';
    expect(shellFor('win32', { PATH: '' }, (p) => p === std).file).toBe(std);
    expect(shellFor('win32', { PATH: '' }, () => false).file).toBe('bash');
  });
});

describe('runStatusLineCommand', () => {
  it('passes stdin to the command and returns its output', async () => {
    expect(await runStatusLineCommand('cat', '{"a":1}')).toBe('{"a":1}');
  });

  it('is empty when the command fails', async () => {
    expect(await runStatusLineCommand('echo out; exit 3', '')).toBe('');
  });

  it('is empty when it takes too long, and returns promptly', async () => {
    const t = Date.now();
    expect(await runStatusLineCommand('sleep 5', '', { timeoutMs: 300 })).toBe('');
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it("marks the command, so one that runs work's hook again stops there", async () => {
    expect(await runStatusLineCommand('echo "n=$WORK_STATUSLINE_NESTED"', '')).toBe('n=1\n');
  });

  it('a command that exits leaving a child on its stdout: its output, at its exit (not at the cap)', async () => {
    const t = Date.now();
    expect(await runStatusLineCommand('sleep 3 & echo hi', '', { timeoutMs: 5000 })).toBe('hi\n');
    expect(Date.now() - t).toBeLessThan(2500);
  });

  // Any platform: the child is node, whose pid (written by itself) is one isPidAlive knows on Windows too.
  it('a timeout stops what the command started, not only the shell', async () => {
    const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sl-kill-')), 'pid');
    const node = process.execPath.replace(/\\/g, '/');
    const js = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 30000)';
    const cmd = `'${node}' -e '${js}' '${pidFile.replace(/\\/g, '/')}'`;
    const run = runStatusLineCommand(cmd, '', { timeoutMs: 1500 });
    expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8') !== '')).toBe(true);
    const child = Number(fs.readFileSync(pidFile, 'utf-8'));
    expect(isPidAlive(child)).toBe(true);
    expect(await run).toBe('');
    expect(await waitFor(() => !isPidAlive(child))).toBe(true);
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  });
});
