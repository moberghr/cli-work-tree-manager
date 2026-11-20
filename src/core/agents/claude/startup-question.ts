/**
 * Claude Code's question before it starts in a folder it hasn't been told to trust, as its terminal shows it:
 *
 *   Accessing workspace: <folder>
 *   Quick safety check: Is this a project you created or one you trust? …
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *
 * (older versions: "Do you trust the files in this folder?" over "1. Yes, proceed"). Recognised by its two answers
 * being the last thing on the screen: a conversation that only mentions the question (a resumed one repaints its
 * history) ends with Claude's prompt, not with them. Pure.
 */
const YES = /^\s*[❯>]?\s*1\.\s+Yes, (?:I trust this folder|proceed)\s*$/;
const NO = /^\s*[❯>]?\s*2\.\s+No, exit\s*$/;
/** How many of the screen's last lines the answers must be among (the answers, then "Enter to confirm · Esc to cancel"). */
const TAIL_LINES = 6;

export const TRUST_QUESTION = 'Claude asks whether you trust this folder: answer in its terminal';

export function claudeStartupQuestion(screen: string): string | null {
  const tail = screen
    .split(/\r?\n/)
    .map((l) => l.replace(/[│┃|]/g, ' ').trimEnd())
    .filter((l) => l.trim())
    .slice(-TAIL_LINES);
  const yes = tail.findIndex((l) => YES.test(l));
  return yes >= 0 && tail.slice(yes + 1).some((l) => NO.test(l)) ? TRUST_QUESTION : null;
}
