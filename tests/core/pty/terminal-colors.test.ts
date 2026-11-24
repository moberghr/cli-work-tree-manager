import { describe, it, expect } from 'vitest';
import { TerminalColors } from '../../../src/core/pty/terminal-colors.js';

describe('TerminalColors', () => {
  it("answers with the Terminal tab's colours as xterm.js says them, until a terminal answered", () => {
    const c = new TerminalColors();
    expect(c.reply('11')).toBe('\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\');
    expect(c.value('10')).toBe('rgb:d4d4/d4d4/d4d4');
    expect(c.value('12')).toBe('rgb:ffff/ffff/ffff');
  });

  it("answers OSC 4 from xterm.js's default palette: the 16, the cube, the greys", () => {
    const c = new TerminalColors();
    expect(c.value('4;1')).toBe('rgb:cccc/0000/0000');
    expect(c.value('4;16')).toBe('rgb:0000/0000/0000');
    expect(c.value('4;196')).toBe('rgb:ffff/0000/0000');
    expect(c.value('4;67')).toBe('rgb:5f5f/8787/afaf');
    expect(c.value('4;232')).toBe('rgb:0808/0808/0808');
    expect(c.value('4;255')).toBe('rgb:eeee/eeee/eeee');
  });

  it('remembers what a terminal answered, by slot, ST- or BEL-terminated', () => {
    const c = new TerminalColors();
    c.remember('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
    c.remember('\x1b]10;#000\x07');
    c.remember('\x1b]4;007;rgb:12/34/56\x1b\\');
    expect(c.reply('11')).toBe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
    expect(c.value('10')).toBe('#000');
    expect(c.value('4;7')).toBe('rgb:12/34/56');
  });

  it('repeats only a colour: anything else a terminal sent is not said back to the agent', () => {
    const c = new TerminalColors();
    for (const reply of [
      '\x1b]11;?\x1b\\',
      '\x1b]11;rgb:1/2/3;\x1b[2J\x1b\\',
      '\x1b]11;red\x1b\\',
      '\x1b]4;256;rgb:1/2/3\x1b\\',
      '\x1b]52;c;aGk=\x1b\\',
      '\x1b[?1;2c',
    ])
      c.remember(reply);
    expect(c.value('11')).toBe('rgb:1e1e/1e1e/1e1e');
    expect(c.value('4;255')).toBe('rgb:eeee/eeee/eeee');
  });
});
