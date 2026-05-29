import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Props {
  source: string;
}

/**
 * Renders a markdown string as sanitized HTML. Used for comment bodies.
 * GFM enabled, single newlines become <br>. Output is sanitized with
 * DOMPurify so even claude-authored comments can't smuggle scripts.
 */
export function Markdown({ source }: Props) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(source, { breaks: true, gfm: true, async: false });
      return DOMPurify.sanitize(String(raw), { USE_PROFILES: { html: true } });
    } catch {
      return null;
    }
  }, [source]);
  if (html === null) {
    return <span>{source}</span>;
  }
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
