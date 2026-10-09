import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yargs from 'yargs';

/**
 * `work timesheet` with a work web that is there but didn't answer in time:
 * it may still be posting (or gathering), so the CLI doesn't do it as well —
 * two posts of a day at once would put each worklog in Tempo twice.
 */
const h = vi.hoisted(() => ({ post: vi.fn(), build: vi.fn(), update: vi.fn() }));
vi.mock('../../src/core/platform/web-discovery.js', () => ({
  callWorkWeb: async () => ({ ok: false, status: -1, error: 'work web did not answer in time: it may still be at it' }),
}));
vi.mock('../../src/core/time/time-actions.js', () => ({ postStoredDay: h.post }));
vi.mock('../../src/core/time/time-days.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/time/time-days.js')>()),
  buildDay: h.build,
}));
vi.mock('../../src/core/time/time-store.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/time/time-store.js')>()),
  updateDay: h.update,
}));

const { timesheetCommand } = await import('../../src/commands/timesheet.js');

let err: string[];
beforeEach(() => {
  err = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void err.push(String(m)));
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  process.env.TEMPO_API_TOKEN = 'tok';
  process.env.JIRA_ACCOUNT_ID = 'acc';
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TEMPO_API_TOKEN;
  delete process.env.JIRA_ACCOUNT_ID;
});

const run = (args: string[]) =>
  yargs(['timesheet', ...args])
    .command(timesheetCommand)
    .strict()
    .fail(false)
    .parseAsync();

describe('work timesheet, work web there but slow', () => {
  it("post, gather and set don't do it themselves: they say so (it may still be at it)", async () => {
    await expect(run(['post', '2026-10-08'])).rejects.toThrow('exit 1');
    await expect(run(['gather', '2026-10-08'])).rejects.toThrow('exit 1');
    await expect(run(['set', '2026-10-08', 'SD-1=7.5'])).rejects.toThrow('exit 1');
    expect(h.post).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('may still be at it');
  });
});
