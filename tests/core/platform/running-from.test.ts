import { describe, expect, it, vi } from 'vitest';
import { spawn as spawnChild } from 'node:child_process';
import { killTreeAsync } from '../../../src/core/platform/process.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commandWords,
  describeProcess,
  holdersOf,
  isWorkProcess,
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

describe("work's own processes are never stopped", () => {
  it('the PTY host and a work web run from a checkout (npm link, a dev build): spared by command line, by recorded pid, and its terminal helpers', () => {
    const repo = 'C:\\Users\\me\\source\\repos\\work-tree';
    const host = p(10, 1, 'node.exe', null, `"node" "${repo}\\dist\\bin.js" pty-host`);
    const conpty = p(
      11,
      10,
      'OpenConsole.exe',
      `${repo}\\node_modules\\node-pty\\build\\Release\\conpty\\OpenConsole.exe`,
      'OpenConsole.exe',
    );
    const web = p(12, 1, 'node.exe', null, `node ${repo}\\dist\\bin.js web --dev`);
    const recorded = p(13, 1, 'node.exe', null, `node ${repo}\\server.js`);
    const vite = p(14, 1, 'node.exe', null, `node ${repo}\\node_modules\\vite\\bin\\vite.js`);
    const bins = [normDir(`${repo}\\dist\\bin.js`, true)]; // this work's own install
    const h = holdersOf([host, conpty, web, recorded, vite], [repo], 99_999, true, new Set([13]), bins);
    expect(h.stoppable.map((x) => x.pid)).toEqual([14]);
  });

  it("a project's own bin.js isn't work's: it runs from the worktree, and is stopped", () => {
    const theirs = p(30, 1, 'node.exe', null, `node ${WT}\\bin.js web --port 3000`);
    const bins = [normDir('C:\\npm\\work\\dist\\bin.js', true)];
    expect(isWorkProcess(theirs, bins, true)).toBe(false);
    expect(holdersOf([theirs], [WT], 99_999, true, new Set(), bins).stoppable.map((x) => x.pid)).toEqual([30]);
    expect(isWorkProcess(p(31, 1, 'node.exe', null, '"node" "C:\\npm\\work\\dist\\bin.js" hook turn-end'), bins, true)).toBe(true);
  });

  it('an editor on a sibling folder whose name starts the same is not on this one', () => {
    const sibling = p(40, 1, 'Code.exe', 'C:\\VS Code\\Code.exe', `"Code.exe" "${WT}2"`);
    const inside = p(41, 1, 'Code.exe', 'C:\\VS Code\\Code.exe', `"Code.exe" "${WT}\\src\\a.ts"`);
    expect(holdersOf([sibling, inside], [WT], 99_999, true).others.map((x) => x.pid)).toEqual([41]);
  });

  it('a folder followed by punctuation is still named (a shell: `cd /d <dir>&& npm run dev`); a longer name is another folder', () => {
    const shell = p(50, 1, 'cmd.exe', 'C:\WINDOWS\system32\cmd.exe', `cmd /c "cd /d ${WT}&& npm run dev"`);
    const old = p(51, 1, 'Code.exe', null, `"Code.exe" "${WT}-old"`);
    expect(holdersOf([shell, old], [WT], 99_999, true).others.map((x) => x.pid)).toEqual([50]);
  });

  it("a dev server a Claude started is stopped though it's still under the PTY host (its Claude not gone yet)", () => {
    const host = p(10, 1, 'node.exe', null, '"node" "C:\\npm\\work\\dist\\bin.js" pty-host');
    const claude = p(20, 10, 'claude.exe', 'C:\\Users\\me\\.local\\bin\\claude.exe', 'claude --continue');
    const shell = p(21, 20, 'bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'bash -c "npm run dev"');
    const dev = p(22, 21, 'node.exe', null, `node ${WT}\\node_modules\\vite\\bin\\vite.js`);
    const h = holdersOf([host, claude, shell, dev], [WT], 99_999, true, new Set([10]));
    expect(h.stoppable.map((x) => x.pid)).toEqual([22]);
  });

  it('a relative script, where the process works (Linux knows it): `node dist/server.js`, `python manage.py`', () => {
    const wt = '/home/me/worktrees/api/feat-x';
    const node = { ...p(1, 0, 'node', '/usr/bin/node', 'node dist/server.js'), cwd: wt };
    const py = { ...p(2, 0, 'python3.12', '/usr/bin/python3.12', 'python manage.py runserver'), cwd: wt };
    const elsewhere = { ...p(3, 0, 'node', '/usr/bin/node', 'node dist/server.js'), cwd: '/home/me/other' };
    expect(runsFrom(node, [wt], false)).toBe(true);
    expect(runsFrom(py, [wt], false)).toBe(true);
    expect(runsFrom(elsewhere, [wt], false)).toBe(false);
  });

  it('shortening the folder in a name keeps the rest whole, a letter whose lower case is longer before it too', () => {
    const odd = p(60, 1, 'node.exe', null, `node --title=İstanbul ${WT}\\server.js`);
    expect(describeProcess(odd, dirs, true)).toBe('node --title=İstanbul …\\server.js (PID 60)');
  });

  it('a versioned interpreter is one (Linux names the binary: python3.12, node22)', () => {
    const wt = '/home/me/worktrees/api/feat-x';
    expect(runsFrom(p(1, 0, 'python3.12', '/usr/bin/python3.12', `/usr/bin/python3.12 ${wt}/manage.py runserver`), [wt], false)).toBe(true);
    expect(runsFrom(p(2, 0, 'node22', '/usr/bin/node22', `node22 ${wt}/server.js`), [wt], false)).toBe(true);
  });

  it('an option before the script (`node -r ts-node/register <dir>/src/index.ts`) still finds the script', () => {
    const ts = p(20, 1, 'node.exe', null, `node -r ts-node/register ${WT}\\src\\index.ts`);
    expect(runsFrom(ts, dirs, true)).toBe(true);
  });

  it('every process running from it is listed, children too (POSIX stops one at a time); the tops are what is named', () => {
    const h = holdersOf([app, appChild], [WT], 99_999, true);
    expect(h.running!.map((x) => x.pid)).toEqual([600, 601]);
    expect(h.stoppable.map((x) => x.pid)).toEqual([600]);
  });
});

describe('killTreeAsync', () => {
  it('stops a real process without blocking', async () => {
    const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const gone = new Promise((r) => child.once('exit', r));
    expect(await killTreeAsync(child.pid!)).toBe(true);
    await gone;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});

describe('stopRunningFrom', () => {
  it('waits for what it stopped to be gone before saying so (the folder is free when it returns)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-from-'));
    try {
      const mine = p(78, 1, 'node', '/usr/bin/node', `node ${path.join(dir, 'server.js')}`);
      let checks = 0;
      const alive = vi.fn(() => ++checks < 3); // exits on the third look
      const said = await stopRunningFrom([dir], { list: async () => [mine], kill: () => true, alive, spare: new Set(), waitMs: 5000 });
      expect(said).toHaveLength(1);
      expect(checks).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops what runs from the folders and says what; nothing for a folder that is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'running-from-'));
    try {
      const mine = p(77, 1, 'node', '/usr/bin/node', `node ${path.join(dir, 'server.js')}`);
      const kill = vi.fn(() => true);
      const said = await stopRunningFrom([dir], { list: async () => [mine], kill, alive: () => false, spare: new Set() });
      // Kills may be asynchronous (taskkill off the event loop); one that fails isn't said to be stopped.
      const failing = await stopRunningFrom([dir], {
        list: async () => [mine],
        kill: async () => false,
        alive: () => false,
        spare: new Set(),
      });
      expect(failing).toEqual([]);
      expect(kill).toHaveBeenCalledWith(77);
      expect(said).toEqual([`node … (PID 77)`.replace('…', `…${path.sep}server.js`)]);
      expect(await stopRunningFrom([path.join(dir, 'gone')], { list: async () => [mine], kill, spare: new Set() })).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
