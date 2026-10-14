import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freeLeftovers, leftoversOf, openInLeftovers, runningFromLeftovers } from '../../../src/core/archive/restore-leftovers.js';
import type { RunningProcess } from '../../../src/core/platform/running-from.js';

let tmp: string;
let left: string;
let worktree: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leftovers-'));
  left = path.join(tmp, 'feat-x'); // what git left: no .git
  fs.mkdirSync(path.join(left, 'node_modules'), { recursive: true });
  worktree = path.join(tmp, 'feat-y');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: elsewhere');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const vite = (): RunningProcess => ({
  pid: 7,
  ppid: 1,
  name: 'node',
  exe: null,
  command: `node ${path.join(left, 'vite.js')} --mode demo`,
});
const editor = (): RunningProcess => ({ pid: 8, ppid: 1, name: 'Code', exe: null, command: `code ${left}` });

describe('restoring over what git left (the dashboard and work tree alike)', () => {
  it('a leftover is a folder with no git in it; a worktree or nothing is not one', () => {
    expect(leftoversOf([left, worktree, path.join(tmp, 'gone')])).toEqual([left]);
  });

  it("what runs from it is named; an editor only names it, for a failure's message", async () => {
    const holders = vi.fn(async () => ({ stoppable: [vite()], others: [editor()] }));
    expect(await runningFromLeftovers([left], { holders })).toEqual([expect.stringContaining('(PID 7)')]);
    expect(await openInLeftovers([left], { holders })).toEqual([expect.stringContaining('(PID 7)'), expect.stringContaining('(PID 8)')]);
  });

  it('nothing to look at, nothing asked; a failed look is no answer, not an error', async () => {
    const holders = vi.fn(async () => ({ stoppable: [vite()], others: [] }));
    expect(await runningFromLeftovers([], { holders })).toEqual([]);
    expect(holders).not.toHaveBeenCalled();
    expect(await runningFromLeftovers([left], { holders: async () => Promise.reject(new Error('no list')) })).toEqual([]);
  });

  it('stopping is only on asking, and says what', async () => {
    const stop = vi.fn(async () => ['node … (PID 7)']);
    expect(await freeLeftovers([left], { stop })).toEqual(['node … (PID 7)']);
    expect(stop).toHaveBeenCalledWith([left]);
    expect(await freeLeftovers([], { stop })).toEqual([]);
  });
});
