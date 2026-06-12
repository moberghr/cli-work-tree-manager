import hljs from 'highlight.js';
import { languageForPath } from './language.js';

// Importing language.js (above) runs its side-effect grammar registration
// (e.g. cshtml-razor), so callers of highlightToLines/resolveHighlightLang
// never have to register anything themselves.

/** Resolve a path to a validated, registered hljs language id, or null. */
export function resolveHighlightLang(path: string): string | null {
  const lang = languageForPath(path);
  return lang && hljs.getLanguage(lang) ? lang : null;
}

/**
 * Highlight a block of source lines as ONE unit (so multi-line grammar state
 * carries across them — see highlightToLines) and return per-line HTML, with
 * null for a line that has no usable highlighting (a blank line, or a failure
 * that takes out the whole block). Returns an array the same length as
 * `contents`. The shared kernel behind the diff/file views — each keys the
 * result against its own line identity (line number, line object, or index).
 */
export function highlightBlock(contents: string[], lang: string): (string | null)[] {
  if (contents.length === 0) return [];
  try {
    const html = highlightToLines(contents.join('\n'), lang);
    // Null out blank/whitespace-only source lines: inside a multi-line span
    // (e.g. Razor's `language-csharp` block) hljs still emits an empty wrapper
    // span for them, which would render an empty <td> and collapse the row.
    // The plain-render fallback shows the original whitespace and keeps height.
    return contents.map((line, i) => (line.trim() ? html[i] || null : null));
  } catch {
    return contents.map(() => null);
  }
}

/**
 * Highlight a contiguous block of source as ONE unit, then split the result
 * into per-line HTML — re-balancing any spans that cross line boundaries.
 *
 * Highlighting line-by-line loses multi-line grammar state: a stateful grammar
 * (Razor's `@code { … }` C# sublanguage, or a block comment / template string
 * in any language) only emits the right tokens once it has seen the opening
 * line. Feeding the whole block to hljs in one call preserves that state; this
 * splitter then hands each source line its own balanced HTML so the diff / file
 * table can drop it straight into a `<td>` via dangerouslySetInnerHTML.
 *
 * Returns one HTML string per input line (same length as `text.split('\n')`).
 */
export function highlightToLines(text: string, lang: string): string[] {
  const html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  const lines: string[] = [];
  // Spans open on this line that must be re-opened at the start of the next.
  const open: string[] = [];
  let cur = '';
  // hljs output is exactly three token kinds: `<span …>` open tags, `</span>`
  // close tags, and HTML-escaped text (so a raw `<` only ever starts a tag).
  const re = /(<span[^>]*>)|(<\/span>)|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else {
      const parts = m[3].split('\n');
      for (let p = 0; p < parts.length; p++) {
        if (p > 0) {
          // Newline inside the token: close every open span, flush the line,
          // then re-open them so the next line is self-contained HTML.
          cur += '</span>'.repeat(open.length);
          lines.push(cur);
          cur = open.join('');
        }
        cur += parts[p];
      }
    }
  }
  lines.push(cur);
  return lines;
}
