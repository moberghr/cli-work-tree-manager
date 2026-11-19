// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '../../src/web/src/api/client.js';
import { ShownFilePane } from '../../src/web/src/components/Dashboard/ShownFilePane.js';
import { markdownOutline } from '../../src/web/src/state/shown-file.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The file a session shows beside its terminal (asked for: a spec to approve had to be read in another tab). */
describe('markdownOutline', () => {
  it('the headings in order, with their level and plain words; none from a code block', () => {
    const md = [
      '# Spec — *DynamoDB* as a `fourth` engine',
      '',
      '## Summary',
      'text',
      '```sh',
      '# not a heading',
      '```',
      '### [Linked](http://x) part ##',
      '',
      'Setext one',
      '=========',
      '',
      'Setext two',
      '----------',
      '- item',
      '---',
      '#no space is no heading',
    ].join('\n');
    expect(markdownOutline(md)).toEqual([
      { level: 1, text: 'Spec — DynamoDB as a fourth engine' },
      { level: 2, text: 'Summary' },
      { level: 3, text: 'Linked part' },
      { level: 1, text: 'Setext one' },
      { level: 2, text: 'Setext two' },
    ]);
    expect(markdownOutline('just text\nand more')).toEqual([]);
  });

  it('a rule under a paragraph is no heading', () => {
    expect(markdownOutline('first line\nsecond line\n---\n')).toEqual([]);
  });
});

describe('ShownFilePane', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const session = { id: 's1', target: 'api', branch: 'feat/x' } as SessionSummary;
  const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
  const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('Markdown is rendered with its contents; a click on one goes to that heading; Close and Code tab are there', async () => {
    const calls: string[] = [];
    let closed = 0;
    let code = 0;
    act(() =>
      root.render(
        createElement(ShownFilePane, {
          session,
          shown: { repo: 'api', path: 'docs/spec.md', at: 't1', kind: 'markdown' },
          onClose: () => void closed++,
          onOpenCode: () => void code++,
          load: async (id, repo, p) => (
            calls.push(`${id} ${repo} ${p}`),
            { text: '# Spec\n\nIntro.\n\n## Behaviour\n\nIt **does** things.\n' }
          ),
        }),
      ),
    );
    await flush();
    expect(calls[0]).toBe('s1 api docs/spec.md');
    expect(text(container.querySelector('.wd-shown-name'))).toBe('docs/spec.md');
    expect([...container.querySelectorAll('.wd-shown-outline li')].map((li) => text(li))).toEqual(['Spec', 'Behaviour']);
    expect(container.querySelector('.wd-shown-body h2')?.textContent).toBe('Behaviour');
    expect(container.querySelector('.wd-shown-body strong')?.textContent).toBe('does');
    // jsdom has no scrollIntoView: each call writes what it was called on.
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? '');
    };
    act(() => (container.querySelectorAll('.wd-shown-outline button')[1] as HTMLButtonElement).click());
    expect(scrolled).toEqual(['Behaviour']);
    act(() => (container.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());
    act(() => ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Code tab') as HTMLButtonElement).click());
    expect([closed, code]).toEqual([1, 1]);
  });

  it('other text is shown as it is; an image is drawn from the session’s image route; what can’t be shown says why', async () => {
    act(() =>
      root.render(
        createElement(ShownFilePane, {
          session,
          shown: { repo: 'api', path: 'src/app.ts', at: 't1', kind: 'text' },
          load: async () => ({ text: 'const a = 1;\n<b>not html</b>' }),
        }),
      ),
    );
    await flush();
    expect(container.querySelector('pre.wd-shown-text')?.textContent).toBe('const a = 1;\n<b>not html</b>');
    expect(container.querySelector('.wd-shown-body b')).toBeNull();
    expect(container.querySelector('.wd-shown-outline')).toBeNull();

    act(() =>
      root.render(
        createElement(ShownFilePane, {
          session,
          shown: { repo: 'api', path: 'shot.png', at: 't 2', kind: 'image' },
          load: async () => Promise.reject(new Error('never read')),
        }),
      ),
    );
    await flush();
    expect(container.querySelector('.wd-shown-body img')?.getAttribute('src')).toBe('/api/sessions/s1/show/image?at=t%202');

    act(() =>
      root.render(
        createElement(ShownFilePane, {
          session,
          shown: { repo: 'api', path: 'big.log', at: 't3', kind: 'text' },
          load: async () => ({ text: null, reason: 'too-large' }),
        }),
      ),
    );
    await flush();
    expect(text(container.querySelector('.wd-shown-body'))).toBe('It is too large to show here.');
  });
});
