import type { TerminalColors } from '../terminal-colors.js';

/**
 * What a program is answered when libghostty-vt answers its query: as xterm.js would have, whichever terminal answers
 * (the PTY host's screen copy with no tab open, the Terminal tab's ghostty engine with one), so an agent sees the same
 * terminal whoever watches (terminal-rendering.md). Pure.
 */

const CSI = '\x1b[';
/** xterm.js's own answers to DA1 and DA2: the browser's terminal, which the agent believes it talks to. */
const XTERM_DA1 = `${CSI}?1;2c`;
const XTERM_DA2 = `${CSI}>0;276;0c`;
/**
 * Answers libghostty gives that xterm.js does not: XTVERSION (which libghostty answers "libghostty" whatever it is
 * told), DA3, XTGETTCAP, the kitty keyboard flags query, kitty graphics, and the OSC 7501 probe (the host never
 * answers it: terminal-rendering.md).
 */
const DROPPED = [/^\x1bP>\|/, /^\x1bP!\|/, /^\x1bP[01]\+r/, /^\x1b\[\?\d*u$/, /^\x1b_G/, /^\x1b\]7501;/];
const COLOR_REPLY = /^\x1b\]((?:1[012])|4;\d+);/;

/**
 * What the agent is answered for libghostty's reply `reply`, or null for none. `colors`: the colour answers rewritten
 * with these (the PTY host's, whose terminal has placeholder colours); without, they go as libghostty gave them (the
 * browser's, whose terminal has the real ones).
 */
export function translateReply(reply: string, colors?: Pick<TerminalColors, 'reply'>): string | null {
  const color = colors ? COLOR_REPLY.exec(reply) : null;
  if (colors && color) return colors.reply(color[1].startsWith('4;') ? `4;${Number(color[1].slice(2))}` : color[1]);
  if (/^\x1b\[\?[\d;]*c$/.test(reply)) return XTERM_DA1;
  if (/^\x1b\[>[\d;]*c$/.test(reply)) return XTERM_DA2;
  return DROPPED.some((re) => re.test(reply)) ? null : reply;
}

/** One reply each: libghostty writes several in one go (OSC 10;?;? gives 10 and 11, OSC 4 one per index). */
const REPLY = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_][^\x1b]*\x1b\\|\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|[^\x1b]+|\x1b/g;

/** What the agent is answered for what libghostty wrote to the PTY (one or more replies). */
export function translateReplies(written: string, colors?: Pick<TerminalColors, 'reply'>): string[] {
  const out: string[] = [];
  for (const [reply] of written.matchAll(REPLY)) {
    const answer = translateReply(reply, colors);
    if (answer) out.push(answer);
  }
  return out;
}
