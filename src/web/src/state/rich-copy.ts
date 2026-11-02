import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Copying so that Teams, Outlook or Word keep the shape: the clipboard gets
 * HTML beside the plain text, and they paste the HTML — a table stays a
 * table (pasted as plain text, a Markdown table is a column of pipes).
 * Their paste keeps inline styles and drops classes, so tables get theirs
 * inline: grid lines and some padding.
 */

const CELL_STYLE = 'border:1px solid #8c959f;padding:4px 8px;text-align:left;vertical-align:top';

/** Tables, header cells and cells with their look inline (`html` is sanitized already). */
export function styleTables(html: string): string {
  return html
    .replace(/<table(\s[^>]*)?>/g, '<table style="border-collapse:collapse"$1>')
    .replace(
      /<(th|td)(\s[^>]*)?>/g,
      (_m, tag: string, attrs = '') => `<${tag} style="${CELL_STYLE}${tag === 'th' ? ';font-weight:600' : ''}"${attrs}>`,
    );
}

/** Markdown (Claude's reply as written) as the HTML a paste keeps: GFM, sanitized, tables styled. */
export function markdownHtml(md: string): string {
  const raw = marked.parse(md, { gfm: true, breaks: false, async: false });
  return styleTables(DOMPurify.sanitize(String(raw), { USE_PROFILES: { html: true } }));
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Both to the clipboard: `html` for what pastes formatted, `text` for the
 * rest. A browser without ClipboardItem (or one that refuses it) gets the
 * text alone.
 */
export async function writeRich(parts: { text: string; html: string | null }): Promise<void> {
  const clip = navigator.clipboard;
  if (parts.html && typeof ClipboardItem !== 'undefined' && clip?.write) {
    try {
      await clip.write([
        new ClipboardItem({
          'text/plain': new Blob([parts.text], { type: 'text/plain' }),
          'text/html': new Blob([parts.html], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      // Refused (a permission, an old WebView): the text still goes.
    }
  }
  await clip.writeText(parts.text);
}
