// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markdownHtml, styleTables, writeRich } from '../../src/web/src/state/rich-copy.js';

afterEach(() => vi.unstubAllGlobals());

describe('markdownHtml — a reply as the HTML Teams, Outlook and Word paste', () => {
  it('a Markdown table is a styled table; bold, lists and code stay; nothing runs', () => {
    const html = markdownHtml('**Done.**\n\n| Option | Cost |\n|---|---|\n| A | 1 |\n\n- one\n\n`x`<script>alert(1)</script>');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('strong')!.textContent).toBe('Done.');
    expect([...doc.querySelectorAll('th')].map((c) => c.textContent)).toEqual(['Option', 'Cost']);
    expect(doc.querySelector('td')!.getAttribute('style')).toContain('border:1px solid');
    expect(doc.querySelector('li')!.textContent).toBe('one');
    expect(doc.querySelector('code')!.textContent).toBe('x');
    expect(doc.querySelector('script')).toBeNull();
  });

  it('styleTables leaves thead/tbody alone and keeps a cell’s own attributes', () => {
    expect(styleTables('<table><thead><tr><th align="right">a</th></tr></thead></table>')).toBe(
      '<table style="border-collapse:collapse"><thead><tr><th style="border:1px solid #8c959f;padding:4px 8px;text-align:left;vertical-align:top;font-weight:600" align="right">a</th></tr></thead></table>',
    );
  });
});

describe('writeRich', () => {
  class FakeItem {
    constructor(readonly parts: Record<string, Blob>) {}
  }
  it('both kinds when there is HTML; the text alone when there is none, or the browser refuses', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', FakeItem);
    Object.defineProperty(navigator, 'clipboard', { value: { write, writeText }, configurable: true });
    await writeRich({ text: 't', html: '<b>t</b>' });
    const item = write.mock.calls[0][0][0] as FakeItem;
    expect(Object.keys(item.parts)).toEqual(['text/plain', 'text/html']);
    expect(await item.parts['text/html'].text()).toBe('<b>t</b>');
    await writeRich({ text: 'plain', html: null });
    expect(writeText).toHaveBeenLastCalledWith('plain');
    write.mockRejectedValueOnce(new Error('NotAllowedError'));
    await writeRich({ text: 'still', html: '<b>still</b>' });
    expect(writeText).toHaveBeenLastCalledWith('still');
  });
});
