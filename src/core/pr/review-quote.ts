/**
 * One line of a reviewer's text, safe to put inside the reminder block an
 * agent reads: no newlines, and no `<` or `>` — a literal
 * `</system-reminder>` in a comment must not be able to close the block and
 * speak as the system. Pure: the PR watch's note and the dashboard's "Ask
 * Claude" both quote with it.
 */
export function quoteForAgent(s: string, max = 600): string {
  const one = s
    .trim()
    .replace(/\r?\n+/g, ' ⏎ ')
    .replace(/\r/g, ' ')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
