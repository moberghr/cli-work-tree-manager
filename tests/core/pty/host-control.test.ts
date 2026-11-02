import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandLineOf, looksLikeHost, restartHost, type StopOutcome } from '../../../src/core/pty/host-control.js';

function steps(outcome: StopOutcome) {
  const stop = vi.fn(async (_force: boolean) => outcome);
  const start = vi.fn(async (_bin: string) => ({ pid: 99 }));
  return { stop, start, pauseMs: 0 };
}

describe('restartHost: stop, then start one that restores every session', () => {
  it.each(['stopped', 'not-running', 'stale-file'] as const)('%s: starts the new host from the given work, answers its pid', async (o) => {
    const s = steps(o);
    expect(await restartHost('/bin/work.js', { force: true }, s)).toEqual({ outcome: o, pid: 99 });
    expect(s.stop).toHaveBeenCalledWith(true);
    expect(s.start).toHaveBeenCalledWith('/bin/work.js');
  });

  it.each(['unresponsive', 'failed'] as const)('%s: never starts a second host beside one it could not stop', async (o) => {
    const s = steps(o);
    expect(await restartHost('/bin/work.js', {}, s)).toEqual({ outcome: o, pid: null });
    expect(s.stop).toHaveBeenCalledWith(false); // without force, a hung host is left alone
    expect(s.start).not.toHaveBeenCalled();
  });
});

describe('commandLineOf: what --force reads before killing a hung host (a real process)', () => {
  const started: ChildProcess[] = [];
  afterEach(() => started.splice(0).forEach((c) => c.kill()));

  it('a process running `… pty-host` is recognised as a host; this test runner is not', async () => {
    // A stand-in for a hung host: node, idling, with `pty-host` on its command line.
    const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'pty-host'], { windowsHide: true, stdio: 'ignore' });
    started.push(fake);
    const line = await commandLineOf(fake.pid!);
    expect(line).toContain('pty-host');
    expect(looksLikeHost(line)).toBe(true);
    expect(looksLikeHost(await commandLineOf(process.pid))).toBe(false);
  }, 30_000);

  it('null for a pid nothing runs as (one that ended: never killed by a guess)', async () => {
    const gone = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => gone.once('exit', r));
    expect(await commandLineOf(gone.pid!)).toBeNull();
  }, 30_000);
});
