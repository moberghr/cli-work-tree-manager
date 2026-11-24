import { describe, it, expect } from 'vitest';
import { CLEAR_SCREEN, attachOutput } from '../../../src/commands/shared/attach-output.js';
import { ACK_EVERY } from '../../../src/core/pty/flow-control.js';

function fakeTerminal() {
  const writes: string[] = [];
  const done: Array<() => void> = [];
  const acks: number[] = [];
  const screen = attachOutput({
    write: (data, cb) => {
      writes.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf-8'));
      done.push(cb);
    },
    ack: (n) => acks.push(n),
  });
  return { screen, writes, acks, drain: () => done.splice(0).forEach((cb) => cb()) };
}

describe('work attach: what it does with the host’s frames', () => {
  it('acks output once your terminal took it (the write callback), counted in the host’s characters', () => {
    const t = fakeTerminal();
    const chunk = Buffer.from('é'.repeat(ACK_EVERY / 2)); // 2 bytes, 1 character each
    t.screen.output(chunk);
    t.screen.output(chunk);
    expect(t.acks).toEqual([]); // written, not yet taken
    t.drain();
    expect(t.acks).toEqual([ACK_EVERY]);
  });

  it('draws the first replay over a cleared screen, and says so (the caller then sends its size and input)', () => {
    const t = fakeTerminal();
    expect(t.screen.replay('screen-1')).toBe(true);
    expect(t.writes).toEqual([CLEAR_SCREEN + 'screen-1']);
  });

  it('draws a later one (it fell behind and caught up) over a cleared screen too — never erasing your history — and is not a first again', () => {
    const t = fakeTerminal();
    t.screen.replay('screen-1');
    t.screen.output(Buffer.from('live'));
    expect(t.screen.replay('screen-2')).toBe(false);
    expect(t.writes.at(-1)).toBe(CLEAR_SCREEN + 'screen-2');
    expect(t.writes.join('')).not.toContain('\x1b[3J'); // your shell's history before the attach stays
    // A screen is never acked (the host doesn't count it).
    t.drain();
    expect(t.acks).toEqual([]);
  });
});
