import { describe, it, expect } from 'vitest';
import { replyParts } from '../../../src/core/pty/terminal-replies.js';

describe('replyParts', () => {
  it('splits what a terminal sent on its own into answers and reports, in order', () => {
    expect(replyParts('\x1b[O\x1b[?1;2c\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\\x1b[<35;4;2M')).toEqual([
      { text: '\x1b[O', answer: false },
      { text: '\x1b[?1;2c', answer: true },
      { text: '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\', answer: true },
      { text: '\x1b[<35;4;2M', answer: false },
    ]);
  });

  it('takes the answers headless xterm and the browser give: DA1/DA2, DSR, CPR, DECXCPR, DECRPM, DECRQSS, XTVERSION', () => {
    for (const answer of [
      '\x1b[?1;2c',
      '\x1b[>0;276;0c',
      '\x1b[0n',
      '\x1b[24;80R',
      '\x1b[?1;1R', // DECXCPR (CSI ? 6 n)
      '\x1b[?24;80;1R', // …with the page
      '\x1b[?2026;2$y',
      '\x1b[4;2$y',
      '\x1bP1$r0m\x1b\\',
      '\x1bP>|xterm.js(6.0.0)\x1b\\',
    ])
      expect(replyParts(answer), JSON.stringify(answer)).toEqual([{ text: answer, answer: true }]);
  });

  it('typing, or typing and replies in one frame, is not replies (never dropped: the host sends it whole)', () => {
    for (const typed of ['', 'k', '\x1b[A', '\x1b[1;2R', '\x1b[?1;2ck', 'k\x1b[O', '\x1b[<0;10;5M']) expect(replyParts(typed)).toBeNull();
  });
});
