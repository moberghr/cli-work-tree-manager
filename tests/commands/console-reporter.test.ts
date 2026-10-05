import { afterEach, describe, expect, it, vi } from 'vitest';
import { consoleReporter, reportStreamFor } from '../../src/commands/shared/console-reporter.js';

describe('reportStreamFor', () => {
  it('sends reports to stderr when stdout carries --json data', () => {
    expect(reportStreamFor(['cleanup', '--apply', 'abc', '--json'])).toBe('stderr');
    expect(reportStreamFor(['sessions', '--json=true'])).toBe('stderr');
  });
  it('keeps them on stdout otherwise, and ignores --json meant for a command after --', () => {
    expect(reportStreamFor(['cleanup', '--apply', 'abc'])).toBe('stdout');
    expect(reportStreamFor(['run', '--all', '--', 'npm', 'ls', '--json'])).toBe('stdout');
  });
});

describe('consoleReporter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('writes every level to stderr in stderr mode, so stdout stays the JSON', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = consoleReporter('stderr');
    r('success', 'Removed worktree: /wt/a');
    r('info', 'x');
    expect(out).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledTimes(2);
  });

  it('writes to stdout in stdout mode, errors still to stderr', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = consoleReporter('stdout');
    r('success', 'ok');
    r('error', 'bad');
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
  });
});
