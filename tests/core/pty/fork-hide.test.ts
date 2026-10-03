import { describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ default: {} }));
import { hideForkConsoles } from '../../../src/core/pty/pty-session.js';

describe('hideForkConsoles', () => {
  const fake = () => {
    const calls: unknown[][] = [];
    const cp = { fork: ((...a: unknown[]) => { calls.push(a); return {}; }) as never };
    hideForkConsoles(cp);
    return { cp: cp as { fork: (...a: unknown[]) => unknown }, calls };
  };

  it("hides the console of node-pty's kill helper (fork(path, args), no options)", () => {
    const { cp, calls } = fake();
    cp.fork('conpty_console_list_agent', ['1234']);
    expect(calls[0]).toEqual(['conpty_console_list_agent', ['1234'], { windowsHide: true }]);
  });

  it('keeps the other call forms and what the caller asked for', () => {
    const { cp, calls } = fake();
    cp.fork('a.js', { silent: true });
    cp.fork('b.js', [], { windowsHide: false });
    expect(calls[0]).toEqual(['a.js', [], { windowsHide: true, silent: true }]);
    expect(calls[1]).toEqual(['b.js', [], { windowsHide: false }]);
  });

  it('wraps only once', () => {
    const { cp, calls } = fake();
    hideForkConsoles(cp as never);
    cp.fork('c.js');
    expect(calls).toHaveLength(1);
  });
});
