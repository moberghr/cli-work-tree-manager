/**
 * Text written by others (meeting subjects, Jira titles, chat names, commit
 * subjects), made safe to put between a prompt's `<<<` and `>>>` data fence:
 * one line (a newline could start what reads as a line of the prompt's own),
 * and no fence marker (a `>>>` in a subject would close the fence early and
 * put what follows outside it). Pure (the server, the demo and the CLI share it).
 */
export function asData(text: string, max = 300): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/<{3,}|>{3,}/g, (m) => m.replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')))
    .trim()
    .slice(0, max);
}
