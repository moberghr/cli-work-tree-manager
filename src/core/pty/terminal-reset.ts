/**
 * What `work attach` writes to your own terminal when it lets go of a session (Ctrl+], the agent ended, the PTY
 * host went away): the agent's input and screen modes would otherwise stay on in the shell you return to — the
 * mouse reporting escape codes on every click, a paste arriving wrapped in 200~/201~, keys stuck in kitty's CSI-u
 * encoding or modifyOtherKeys, no cursor, a scroll region, the alternate screen. Fixed, not tracked: the client
 * doesn't parse what it shows, and each of these is harmless to say when it is already off. Pure (no imports).
 *
 * - kitty keyboard flags: pop more than any stack holds (which empties it), then flags 0 — once for the alternate
 *   screen's stack and once, after leaving it, for the main screen's (kitty keeps one per screen).
 * - ESC 7 before 1049l: 1049l puts back the cursor 1049h saved; on the main screen already, it puts back the one
 *   ESC 7 just saved, so the cursor stays where it is.
 * - The scroll region: DECSTBM homes the cursor, so between ESC 7 and ESC 8.
 * - `CSI > 4 m` (modifyOtherKeys back to default) before the SGR reset: a terminal that doesn't know it may take it
 *   for SGR 4 (underline), which the reset at the end undoes.
 */
const KITTY_KEYS_OFF = '\x1b[<255u\x1b[=0;1u';

export const TERMINAL_RESET =
  KITTY_KEYS_OFF +
  '\x1b7\x1b[?1049l' +
  KITTY_KEYS_OFF +
  '\x1b[?9;1000;1002;1003;1005;1006;1015;1016l' + // mouse reporting off, every encoding
  '\x1b[?1004;2004l' + // focus reports, bracketed paste
  '\x1b[?1l\x1b>' + // cursor keys and keypad: normal
  '\x1b[>4m' + // modifyOtherKeys: default
  '\x1b7\x1b[r\x1b8' + // scroll region: the whole screen
  '\x1b[0 q\x1b[?25h' + // cursor: the terminal's own shape, shown
  '\x1b(B\x1b[0m'; // ASCII, default colours
