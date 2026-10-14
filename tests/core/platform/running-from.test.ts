import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commandWords,
  describeProcess,
  holdersOf,
  normDir,
  parseCimProcesses,
  parsePsProcesses,
  runsFrom,
  stopRunningFrom,
  type RunningProcess,
} from '../../../src/core/platform/running-from.js';

const WT = 'C:\\Users\\me\\source\\repos\\worktrees\\warp\\feat-put-version-warp';
const dirs = [normDir(WT, true)];
const p = (pid: number, ppid: number, name: string, exe: string | null, command: string): RunningProcess => ({
  pid,
  ppid,
  name,
  exe,
  command,
});

// What the real case looked like: cmd.exe running `vite`, its node holding a file in node_modules.
const vite = p(
  35464,
  44868,
  'node.exe',
  'C:\\Program Files\\nodejs\\node.exe',
  `"node"   "${WT}\\src\\ui\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js" --mode demo --port 5173 --strictPort`,
);
const cmd = p(
  44868,
  31544,
  'cmd.exe',
  'C:\\WINDOWS\\system32\\cmd.exe',
  'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite --mode demo --port 5173',
);
const code = p(500, 1, 'Code.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', `"Code.exe" "${WT}"`);
const app = p(
  600,
  1,
  'Warp.Api.exe',
  `${WT}\\src\\Warp.Api\\bin\\Debug\\net9.0\\Warp.Api.exe`,
  `"${WT}\\src\\Warp.Api\\bin\\Debug\\net9.0\\Warp.Api.exe"`,
);
const appChild = p(601, 600, 'Warp.Worker.exe', `${WT}\\bin\\Warp.Worker.exe`, `"${WT}\\bin\\Warp.Worker.exe"`);
const elsewhere = p(700, 1, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', 'node C:\\other\\server.js --root C:\\Users\\me\\x');

describe('what runs from a folder', () => {
  it("a script under it run by an interpreter (the vite left running), or an executable in it — not cmd that only named a command, not someone else's", () => {
    expect(runsFrom(vite, dirs, true)).toBe(true);
    expect(runsFrom(app, dirs, true)).toBe(true);
    expect(runsFrom(cmd, dirs, true)).toBe(false);
    expect(runsFrom(elsewhere, dirs, true)).toBe(false);
  });

  it('an editor opened on it only names it: listed for the message, never stopped', () => {
    expect(runsFrom(code, dirs, true)).toBe(false);
    const h = holdersOf([vite, cmd, code, app, appChild, elsewhere], [WT], 99_999, true);
    expect(h.stoppable.map((x) => x.pid)).toEqual([35464, 600]); // the app's child goes with it (a tree kill)
    expect(h.others.map((x) => x.pid)).toEqual([500]);
  });

  it('never this process or one it runs under', () => {
    const me = p(42, 600, 'node.exe', 'C:\\Program Files\\nodejs\\node.exe', `node ${WT}\\x.js`);
    const h = holdersOf([app, me], [WT], 42, true);
    expect(h.stoppable).toEqual([]); // 600 is its parent
  });

  it("case and slashes don't matter on Windows; a folder whose name only starts the same is another", () => {
    const fwd = p(1, 0, 'node.exe', null, `node ${WT.replace(/\\/g, '/').toUpperCase()}/a.js`);
    expect(runsFrom(fwd, dirs, true)).toBe(true);
    const sibling = p(2, 0, 'node.exe', null, `node ${WT}-2\\a.js`);
    expect(runsFrom(sibling, dirs, true)).toBe(false);
  });

  it('described by name and command, the folder shortened', () => {
    expect(describeProcess(vite, dirs, true)).toBe(
      'node …\\src\\ui\\node_modules\\.bin\\\\..\\vite\\bin\\vite.js --mode demo --port 5173 --strictPort (PID 35464)',
    );
    expect(describeProcess(app, dirs, true)).toBe('warp.api (PID 600)');
  });

  it('on macOS and Linux too (paths as they are)', () => {
    const wt = '/Users/me/worktrees/api/feat-x';
    const procs = parsePsProcesses(
      [`  10     1 /usr/local/bin/node ${wt}/node_modules/vite/bin/vite.js`, `  11     1 /usr/bin/vim ${wt}/a.ts`, ''].join('\n'),
    );
    const h = holdersOf(procs, [wt], 99_999, false);
    expect(h.stoppable.map((x) => x.pid)).toEqual([10]);
    expect(h.others.map((x) => x.pid)).toEqual([11]);
  });
});

describe('reading the process list', () => {
  it("Windows' CIM JSON: a list, or one object; unreadable is none", () => {
    const one = { ProcessId: 5, ParentProcessId: 1, Name: 'node.exe', ExecutablePath: null, CommandLine: null };
    expect(parseCimProcesses(JSON.stringify([one]))).toEqual([{ pid: 5, ppid: 1, name: 'node.exe', exe: null, command: '' }]);
    expect(parseCimProcesses(JSON.stringify(one))).toHaveLength(1);
    expect(parseCimProcesses('nope')).toEqual([]);
  });

  it('command words: quotes group and are dropped', () => {
    expect(commandWords('"C:\\Program Files\\node.exe"  a.js "b c"')).toEqual(['C:\\Program Files\\node.exe', 'a.js', 'b c']);
  });
});

describe('stopRunningFrom', () => {
  it('stops what runs from the folders and says what; nothing for a folder that is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-from-'));
    try {
      const mine = p(77, 1, 'node', '/usr/bin/node', `node ${path.join(dir, 'server.js')}`);
      const kill = vi.fn(() => true);
      const said = await stopRunningFrom([dir], { list: async () => [mine], kill });
      expect(kill).toHaveBeenCalledWith(77);
      expect(said).toEqual([`node … (PID 77)`.replace('…', `…${path.sep}server.js`)]);
      expect(await stopRunningFrom([path.join(dir, 'gone')], { list: async () => [mine], kill })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
