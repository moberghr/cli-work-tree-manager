import type { AgentInput } from './types.js';

/** Between the text and Enter: Claude Code (and others) read a burst of input as a paste, and a `\r` in it as part of the paste. */
export const SUBMIT_DELAY_MS = 250;

/**
 * Type `text` into a terminal prompt and submit it: the text, a pause, then
 * Enter as `\r` (what the Enter key sends; a `\n` only adds a line to the
 * prompt, which left every pushed note sitting unsent in the input box),
 * written apart from the text.
 */
export const typeThenEnter: AgentInput['submit'] = async (write, text, wait = (ms) => new Promise((r) => setTimeout(r, ms))) => {
  if (!(await write(text))) return false;
  await wait(SUBMIT_DELAY_MS);
  return write('\r');
};
