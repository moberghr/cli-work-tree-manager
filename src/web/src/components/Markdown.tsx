import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

interface Props {
  source: string;
  /** Wrap the rendered HTML in a `<div>` instead of `<span>` and skip
   *  `breaks: true`. Use for full-document previews (.md files) where
   *  block-level elements inside a span would be invalid HTML and single
   *  newlines should NOT become `<br>`. Default `false` keeps the
   *  comment-body behaviour. */
  block?: boolean;
  className?: string;
}

/**
 * Renders a markdown string as sanitized HTML. Used for comment bodies and
 * (with `block`) for the `.md` rendered preview in the diff view. GFM
 * enabled; output is sanitized with DOMPurify so even claude-authored
 * content can't smuggle scripts.
 */
export function Markdown({ source, block, className }: Props) {
  const html = useMemo(() => {
    try {
      const raw = marked.parse(source, {
        breaks: !block,
        gfm: true,
        async: false,
      });
      return DOMPurify.sanitize(String(raw), { USE_PROFILES: { html: true } });
    } catch {
      return null;
    }
  }, [source, block]);
  if (html === null) {
    return block ? (
      <div className={className}>{source}</div>
    ) : (
      <span className={className}>{source}</span>
    );
  }
  if (block) {
    return (
      <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  return (
    <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
