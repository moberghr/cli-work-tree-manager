import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The wiring: defaultRunner must start exactly what launchFor decided (its absolute path on PATH, an
// interpreter for a shim), never the name it was given — cross-spawn would look that up again, the
// working folder first on Windows.
const spawned: { cmd: string; args: string[]; opts: { cwd?: string } }[] = [];
const launch = vi.fn();

vi.mock('../../../src/core/platform/batch-launch.js', () => ({ launchFor: (...a: unknown[]) => launch(...a) }));
vi.mock('../../../src/core/platform/spawn.js', () => ({
  default: (cmd: string, args: string[], opts: { cwd?: string }) => {
    spawned.push({ cmd, args, opts });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('ok'));
      child.emit('close', 0);
    });
    return child;
  },
}));

const { defaultRunner } = await import('../../../src/core/platform/command-runner.js');

describe('defaultRunner starts what launchFor resolved', () => {
  beforeEach(() => {
    spawned.length = 0;
    launch.mockReset();
  });

  it('spawns the resolved program and arguments, in the given folder', async () => {
    launch.mockReturnValue({ cmd: 'C:\\Program Files\\Azure\\CLI2\\python.exe', args: ['-IBm', 'azure.cli', 'repos', 'list'] });
    const r = await defaultRunner('az', ['repos', 'list'], 'C:\\work\\wt');
    expect(launch).toHaveBeenCalledWith('az', ['repos', 'list']);
    expect(spawned).toEqual([
      {
        cmd: 'C:\\Program Files\\Azure\\CLI2\\python.exe',
        args: ['-IBm', 'azure.cli', 'repos', 'list'],
        opts: expect.objectContaining({ cwd: 'C:\\work\\wt', windowsHide: true }),
      },
    ]);
    expect(r).toEqual({ code: 0, stdout: 'ok', stderr: '' });
  });

  it('a refusal starts nothing and says why', async () => {
    launch.mockReturnValue({ refused: 'tool: refused: an argument has "&"' });
    const r = await defaultRunner('tool', ['a&b'], 'C:\\work\\wt');
    expect(spawned).toEqual([]);
    expect(r).toEqual({ code: 1, stdout: '', stderr: 'tool: refused: an argument has "&"' });
  });
});
