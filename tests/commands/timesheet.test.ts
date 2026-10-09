import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';
import { timesheetCommand } from '../../src/commands/timesheet.js';
import { readDay } from '../../src/core/time/time-store.js';
import { saveConfig } from '../../src/core/platform/config.js';
import os from 'node:os';
import path from 'node:path';

/**
 * `work timesheet` with no work web running (tests have their own HOME):
 * changes are made in-process, in state.db.
 */

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void err.push(String(m)));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  saveConfig({
    worktreesRoot: path.join(os.homedir(), 'wt'),
    repos: {},
    groups: {},
    copyFiles: [],
    time: { gapTicket: 'SD-434', timeOffTicket: 'INT-1' },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

const run = async (args: string[]) =>
  yargs(['timesheet', ...args])
    .command(timesheetCommand)
    .strict()
    .fail(false)
    .parseAsync();
const text = () => out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

describe('work timesheet', () => {
  it("set: all of a day's rows; show prints them; reset goes back; off books the time-off ticket", async () => {
    await run(['set', '2026-10-08', 'sd-1=2.5', 'SD-434=5']);
    expect(readDay('2026-10-08')?.edited).toEqual([
      { key: 'SD-1', hours: 2.5 },
      { key: 'SD-434', hours: 5 },
    ]);
    out = [];
    await run(['show', '2026-10-08']);
    expect(text()).toContain('2026-10-08  edited  7.5 / 7.5 h');
    expect(text()).toMatch(/SD-1\s+2\.5 h/);
    out = [];
    await run(['show', '2026-10-08', '--json']);
    expect(JSON.parse(out[0])).toMatchObject({ day: '2026-10-08', status: 'edited', total: 7.5 });
    await run(['reset', '2026-10-08']);
    expect(readDay('2026-10-08')?.edited).toBeNull();
    out = [];
    await run(['off', '2026-10-08']);
    expect(text()).toContain('INT-1');
    await run(['off', '2026-10-08', '--undo']);
    expect(readDay('2026-10-08')?.dayOff).toBe(false);
  });

  it('refuses rows that are not KEY=HOURS in steps, and a day that is not one', async () => {
    await expect(run(['set', '2026-10-08', 'SD-1=1.1'])).rejects.toThrow('exit 1');
    expect(err.join('\n')).toContain('KEY=HOURS');
    await expect(run(['show', 'someday'])).rejects.toThrow('exit 1');
    expect(err.join('\n')).toContain('Not a day: someday');
  });

  it('post without Tempo set up says why (here: no token), and posts nothing', async () => {
    const before = process.env.TEMPO_API_TOKEN;
    delete process.env.TEMPO_API_TOKEN;
    try {
      await expect(run(['post', '2026-10-08'])).rejects.toThrow('exit 1');
      expect(err.join('\n')).toContain('No Tempo token');
    } finally {
      if (before !== undefined) process.env.TEMPO_API_TOKEN = before;
    }
  });
});
