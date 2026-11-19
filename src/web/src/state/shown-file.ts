/**
 * The contents of a Markdown file, for the pane a session shows a file in (ShownFilePane): its headings in order,
 * each with its level and its words. ATX headings (`## Title`) and setext ones (`Title` over `===` or `---`); none
 * inside a fenced code block. The order is the rendered page's, so the nth entry is the page's nth heading. Pure.
 */
export function markdownOutline(source: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  const lines = source.split(/\r?\n/);
  let fence: string | null = null;
  const plain = (s: string) =>
    s
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      const text = plain(atx[2]);
      if (text) out.push({ level: atx[1].length, text });
      continue;
    }
    const under = lines[i + 1];
    if (
      line.trim() &&
      under !== undefined &&
      /^\s{0,3}(=+|-+)\s*$/.test(under) &&
      !/^\s*([-*+>]|\d+[.)])\s/.test(line) &&
      !/^\s{4,}/.test(line)
    ) {
      // A `---` under a paragraph line is a heading only when that line stands alone (a blank line, or the start, above it).
      if (i === 0 || !lines[i - 1].trim()) {
        const text = plain(line);
        if (text) out.push({ level: under.trim().startsWith('=') ? 1 : 2, text });
        i++;
      }
    }
  }
  return out;
}
