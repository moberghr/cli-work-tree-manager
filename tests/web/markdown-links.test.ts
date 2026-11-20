// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import DOMPurify from 'dompurify';
import { markdownToHtml } from '../../src/web/src/components/Markdown.js';

const links = (html: string) => [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a')];

describe('markdownToHtml — links open outside the page', () => {
  it('a URL in a comment opens in a new tab, never in place', () => {
    const all = links(markdownToHtml('see https://my.adventures.is and [docs](https://example.com/x)'));
    expect(all.map((l) => l.getAttribute('href'))).toEqual(['https://my.adventures.is', 'https://example.com/x']);
    for (const l of all) {
      expect(l.getAttribute('target')).toBe('_blank');
      expect(l.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('a relative link in a .md preview too; an in-page anchor stays', () => {
    const [rel, anchor] = links(markdownToHtml('[a](docs/a.md) [b](#usage)', true));
    expect(rel.getAttribute('target')).toBe('_blank');
    expect(anchor.hasAttribute('target')).toBe(false);
  });

  it('still sanitized, and the hook stays on its own DOMPurify', () => {
    const html = markdownToHtml('[x](javascript:alert(1)) <img src=x onerror=alert(1)>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror');
    expect(DOMPurify.sanitize('<a href="https://a.b">a</a>')).not.toContain('target');
  });
});
