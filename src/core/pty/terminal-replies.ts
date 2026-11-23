/**
 * What a terminal sends with nobody typing: answers to the agent's queries, and reports nobody asked for (focus
 * in/out, the mouse moving with no button down). Every attached client answers a query, and a hidden one still
 * reports focus, so none of these count as using a client (the PTY's size follows the client used last,
 * pty-host.ts). Only one of them answers the agent (terminal-rendering.md, "Who answers a query"). Pure.
 */

/** One sequence of what a terminal sent on its own. */
export interface ReplyPart {
  text: string;
  /** An answer to a query (only the client answering the agent's queries gets it through); false: a focus or mouse-motion report. */
  answer: boolean;
}

/** Focus in/out, and the mouse moving with no button down (SGR motion reports, codes 35 + modifiers), which hovering sends. */
const REPORT = String.raw`\x1b\[[IO]|\x1b\[<(?:35|39|43|47|51|55|59|63);\d+;\d+M`;
/**
 * Answers: device attributes, cursor position (and DECXCPR's `CSI ? row ; col R`), status, kitty keyboard flags,
 * DECRPM, window reports, OSC / DCS / APC replies. A cursor-position report at row 1 and columns 2–8 looks just like
 * Shift/Alt/Ctrl+F3 (`ESC[1;2R` …), so it is taken for the key.
 */
const ANSWER = String.raw`\x1b\[[?>=][\d;]*c|\x1b\[(?!1;[2-8]R)\d+;\d+R|\x1b\[\?\d+;\d+(?:;\d+)?R|\x1b\[\??\d*n|\x1b\[\?\d*u|\x1b\[\??[\d;]*\$y|\x1b\[\d+(?:;\d+)*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P_][\s\S]*?\x1b\\`;
const PART = new RegExp(`(${REPORT})|(?:${ANSWER})`, 'y');

/** `data` as the replies it is made of, in order; null when anything in it is not one (typing, or typing and replies in one frame). */
export function replyParts(data: string): ReplyPart[] | null {
  if (!data) return null;
  const parts: ReplyPart[] = [];
  PART.lastIndex = 0;
  while (PART.lastIndex < data.length) {
    const at = PART.lastIndex;
    const m = PART.exec(data);
    if (!m || m.index !== at || !m[0]) return null;
    parts.push({ text: m[0], answer: m[1] === undefined });
  }
  return parts;
}

/** Whether `data` is only what a terminal sends on its own (`replyParts`): not someone using it. */
export function isTerminalReply(data: string): boolean {
  return replyParts(data) !== null;
}
