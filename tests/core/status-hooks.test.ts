import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StatusHook } from '../../src/core/config.js';

// Mock node:child_process.spawn so no real process is launched.
const spawnMock = vi.fn(() => ({
  on: vi.fn(),
  unref: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { runStatusHooks } from '../../src/core/status-hooks.js';

describe('runStatusHooks', () => {
  beforeEach(() => {
    spawnMock.mockClear();
    spawnMock.mockImplementation(() => ({ on: vi.fn(), unref: vi.fn() }));
  });

  it('spawns only hooks whose `on` matches the kind', () => {
    const hooks: StatusHook[] = [
      { on: 'idle', command: 'echo idle' },
      { on: 'needs_input', command: 'echo input' },
      { on: 'idle', command: 'echo idle2' },
    ];

    runStatusHooks('idle', '/tmp/session', 'session', hooks);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const commands = spawnMock.mock.calls.map((c) => c[0]);
    expect(commands).toEqual(['echo idle', 'echo idle2']);
  });

  it('passes the session cwd as the spawn cwd option (not interpolated)', () => {
    const hooks: StatusHook[] = [{ on: 'needs_input', command: 'beep' }];

    runStatusHooks('needs_input', '/work/dir', 'dir', hooks);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const opts = spawnMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.cwd).toBe('/work/dir');
    expect(opts.shell).toBe(true);
    expect(opts.detached).toBe(true);
    const env = opts.env as Record<string, string>;
    expect(env.WORK_SESSION).toBe('dir');
    expect(env.WORK_STATUS).toBe('needs_input');
  });

  it('does not propagate when spawn throws', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const hooks: StatusHook[] = [{ on: 'idle', command: 'bad-cmd' }];

    expect(() => runStatusHooks('idle', '/tmp', 'tmp', hooks)).not.toThrow();
  });

  it('is a no-op for undefined hooks', () => {
    runStatusHooks('idle', '/tmp', 'tmp', undefined);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty hooks array', () => {
    runStatusHooks('idle', '/tmp', 'tmp', []);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('is a no-op when no hook matches the kind', () => {
    const hooks: StatusHook[] = [{ on: 'needs_input', command: 'beep' }];
    runStatusHooks('idle', '/tmp', 'tmp', hooks);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
