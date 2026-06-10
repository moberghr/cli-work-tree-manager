import { describe, it, expect } from 'vitest';
import { splitInputChunks, editLine, sanitizePaste, KEYS, type LineState } from '../../src/tui-ink/line-editor.js';

describe('splitInputChunks', () => {
  it('passes single printable chars through', () => {
    expect(splitInputChunks('a')).toEqual(['a']);
  });

  it('groups consecutive printable chars into one token (paste)', () => {
    expect(splitInputChunks('hello world')).toEqual(['hello world']);
  });

  it('splits batched arrow keys into individual tokens', () => {
    expect(splitInputChunks('\x1B[A\x1B[A\x1B[B')).toEqual(['\x1B[A', '\x1B[A', '\x1B[B']);
  });

  it('separates escape sequences from printable runs', () => {
    expect(splitInputChunks('ab\x1B[Acd')).toEqual(['ab', '\x1B[A', 'cd']);
  });

  it('parses SGR mouse sequences as single tokens', () => {
    expect(splitInputChunks('\x1B[<64;10;5M\x1B[<65;10;5M')).toEqual([
      '\x1B[<64;10;5M',
      '\x1B[<65;10;5M',
    ]);
  });

  it('emits control chars as individual tokens', () => {
    expect(splitInputChunks('\r\t\x03')).toEqual(['\r', '\t', '\x03']);
  });

  it('handles a lone ESC', () => {
    expect(splitInputChunks('\x1B')).toEqual(['\x1B']);
  });

  it('parses SS3 application cursor keys', () => {
    expect(splitInputChunks('\x1BOA')).toEqual(['\x1BOA']);
  });

  it('splits multi-key sequences like pgup followed by text', () => {
    expect(splitInputChunks('\x1B[5~x')).toEqual(['\x1B[5~', 'x']);
  });

  it('is lossless for mixed content', () => {
    const input = 'foo\x1B[D\x7Fbar\r';
    expect(splitInputChunks(input).join('')).toBe(input);
  });
});

describe('sanitizePaste', () => {
  it('keeps plain text', () => {
    expect(sanitizePaste('feature-branch')).toBe('feature-branch');
  });

  it('stops at the first newline', () => {
    expect(sanitizePaste('line one\nline two')).toBe('line one');
    expect(sanitizePaste('line one\r\nline two')).toBe('line one');
  });

  it('strips embedded control characters', () => {
    expect(sanitizePaste('a\x07b\x1Bc')).toBe('abc');
  });
});

describe('editLine', () => {
  const state = (value: string, pos: number): LineState => ({ value, pos });

  it('inserts printable text at the cursor', () => {
    const r = editLine(state('ac', 1), 'b');
    expect(r.state).toEqual({ value: 'abc', pos: 2 });
    expect(r.action).toBeNull();
  });

  it('inserts pasted runs wholesale', () => {
    const r = editLine(state('', 0), 'feature/login');
    expect(r.state).toEqual({ value: 'feature/login', pos: 13 });
  });

  it('backspace deletes before the cursor', () => {
    expect(editLine(state('abc', 2), KEYS.BACKSPACE).state).toEqual({ value: 'ac', pos: 1 });
  });

  it('backspace at position 0 is a no-op', () => {
    expect(editLine(state('abc', 0), KEYS.BACKSPACE).state).toEqual({ value: 'abc', pos: 0 });
  });

  it('delete removes at the cursor', () => {
    expect(editLine(state('abc', 1), KEYS.DELETE).state).toEqual({ value: 'ac', pos: 1 });
  });

  it('arrows move the cursor with clamping', () => {
    expect(editLine(state('ab', 1), KEYS.LEFT).state.pos).toBe(0);
    expect(editLine(state('ab', 0), KEYS.LEFT).state.pos).toBe(0);
    expect(editLine(state('ab', 1), KEYS.RIGHT).state.pos).toBe(2);
    expect(editLine(state('ab', 2), KEYS.RIGHT).state.pos).toBe(2);
  });

  it('home/end jump to the boundaries', () => {
    expect(editLine(state('abc', 1), KEYS.HOME).state.pos).toBe(0);
    expect(editLine(state('abc', 1), KEYS.END).state.pos).toBe(3);
  });

  it('ctrl+u kills to start of line', () => {
    expect(editLine(state('abcdef', 3), KEYS.CTRL_U).state).toEqual({ value: 'def', pos: 0 });
  });

  it('enter submits, esc and ctrl+c cancel', () => {
    expect(editLine(state('x', 1), KEYS.ENTER).action).toBe('submit');
    expect(editLine(state('x', 1), KEYS.ESC).action).toBe('cancel');
    expect(editLine(state('x', 1), KEYS.CTRL_C).action).toBe('cancel');
  });

  it('ignores unknown escape sequences', () => {
    const r = editLine(state('ab', 1), '\x1B[Z');
    expect(r.state).toEqual({ value: 'ab', pos: 1 });
    expect(r.action).toBeNull();
  });

  it('sanitizes pasted text with control chars and newlines', () => {
    const r = editLine(state('', 0), 'first\x07line\nsecond');
    expect(r.state.value).toBe('firstline');
  });
});
