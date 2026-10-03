import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectingReporter, report, withReporter, type ReportLevel } from '../../../src/core/platform/report.js';
import { consoleReporter } from '../../../src/commands/shared/console-reporter.js';

afterEach(() => vi.restoreAllMocks());

describe('report', () => {
  it('goes to the reporter in scope, across awaits, and each concurrent scope keeps its own', async () => {
    const a = collectingReporter();
    const b = collectingReporter();
    const work = async (tag: string) => {
      report('step', `${tag} 1`);
      await new Promise((r) => setTimeout(r, 5));
      report('error', `${tag} 2`);
    };
    await Promise.all([withReporter(a, () => work('a')), withReporter(b, () => work('b'))]);
    expect(a.entries).toEqual([{ level: 'step', text: 'a 1' }, { level: 'error', text: 'a 2' }]);
    expect(b.errors()).toEqual(['b 2']);
  });

  it('outside any scope it prints nothing (it goes to the debug log)', () => {
    const log = vi.spyOn(console, 'log');
    const err = vi.spyOn(console, 'error');
    report('error', 'quiet');
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });
});

describe('consoleReporter (the CLI)', () => {
  it('writes to stdout, or to stderr for wd, and errors always to stderr', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = consoleReporter('stdout');
    for (const level of ['step', 'info', 'detail', 'success', 'warn'] as ReportLevel[]) out(level, level);
    out('error', 'boom');
    expect(log).toHaveBeenCalledTimes(5);
    expect(err).toHaveBeenCalledTimes(1);
    consoleReporter('stderr')('info', 'status');
    expect(err).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledTimes(5);
  });
});
