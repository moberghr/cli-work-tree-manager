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
 * Our own DOMPurify, so its hook doesn't reach anyone else's sanitize. Every
 * link in rendered markdown (a URL in a comment, a PR description, a .md
 * preview) opens in a new tab, which the desktop app hands to the user's
 * browser: followed in place it replaced the dashboard, and in the app there
 * was no way back. An in-page `#anchor` stays.
 */
let ownPurify: ReturnType<typeof DOMPurify> | null = null;
/**
 * Made when first used, not when this file is loaded: `window` isn't there for a test (or anything) that only
 * imports a component which imports this one, and a whole test file failed on that import (the 2.12.1 release's tests).
 */
function purify(): ReturnType<typeof DOMPurify> {
  if (ownPurify) return ownPurify;
  ownPurify = DOMPurify(window);
  ownPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    const href = node.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  return ownPurify;
}

/** Markdown → sanitized HTML whose links open outside the page. */
export function markdownToHtml(source: string, block = false): string {
  const raw = marked.parse(source, { breaks: !block, gfm: true, async: false });
  return purify().sanitize(String(raw), { USE_PROFILES: { html: true } });
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
      return markdownToHtml(source, block);
    } catch {
      return null;
    }
  }, [source, block]);
  if (html === null) {
    return block ? <div className={className}>{source}</div> : <span className={className}>{source}</span>;
  }
  if (block) {
    return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
