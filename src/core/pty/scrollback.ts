/**
 * How much of a terminal's history is kept, in one place for the PTY host's screen mirror and the browser's
 * terminal (the SPA imports this file: it stays pure and import-free).
 *
 * REPLAY_SCROLLBACK is what a client gets back when it attaches: the mirror keeps that many lines above the
 * screen, and all of them are serialized into the `replay` frame. Measured on a 200-column screen of coloured
 * agent output (terminal-rendering.md): 200 lines serialize in ~3 ms to a 50 KiB frame, 2000 in ~17 ms to
 * 410 KiB, 5000 in ~33 ms to 1 MiB — past what an attach can spend without being felt, and each mirror holds
 * its lines for as long as the session runs (~12 MiB at 2000 lines and 200 columns, ~21 MiB at 5000).
 *
 * VIEW_SCROLLBACK is what an open Terminal tab keeps while it stays connected: it costs that tab's memory only
 * and nothing at an attach, so it may keep more than a reattach brings back.
 */
export const REPLAY_SCROLLBACK = 2000;
export const VIEW_SCROLLBACK = 5000;
