// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { revealInScroller, scrollTopFor, scrollerOf } from '../../src/web/src/utils/scroll.js';

describe('scrollTopFor', () => {
  it('puts the child at the top, below its scroll margin', () => {
    expect(scrollTopFor(1000, 300, 40, 600, 5000, 4, 'start')).toBe(1296);
  });

  it('centres the child', () => {
    expect(scrollTopFor(1000, 300, 40, 600, 5000, 0, 'center')).toBe(1000 + 300 - 280);
  });

  it('stops at the end instead of going past it (a file near the end)', () => {
    expect(scrollTopFor(4800, 500, 40, 600, 4900, 0, 'start')).toBe(4900);
  });

  it('never goes above the top', () => {
    expect(scrollTopFor(10, -200, 40, 600, 5000, 0, 'start')).toBe(0);
  });
});

/** A box with the layout jsdom doesn't compute. */
function box(overflowY: string, { top = 0, scrollHeight = 0, clientHeight = 0 } = {}): HTMLElement {
  const el = document.createElement('div');
  el.style.overflowY = overflowY;
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight });
  el.getBoundingClientRect = () => ({ top, bottom: top + clientHeight, height: clientHeight }) as DOMRect;
  return el;
}

describe('revealInScroller', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  // The dashboard: a page that can't scroll (overflow hidden, but taller than
  // its box) around the diff pane. Ticking Viewed on a file near the end once
  // scrolled the outer box with scrollIntoView, sliding the whole app up.
  it('scrolls only the diff pane, never the hidden-overflow box around it', () => {
    const outer = box('hidden', { scrollHeight: 1200, clientHeight: 800 });
    const pane = box('auto', { top: 200, scrollHeight: 3000, clientHeight: 600 });
    const file = document.createElement('article');
    file.getBoundingClientRect = () => ({ top: 700, bottom: 740, height: 40 }) as DOMRect;
    pane.scrollTop = 2300;
    pane.append(file);
    outer.append(pane);
    document.body.append(outer);

    expect(scrollerOf(file)).toBe(pane);
    revealInScroller(file);
    expect(pane.scrollTop).toBe(2400); // as far as it goes (3000 − 600)
    expect(outer.scrollTop).toBe(0);
  });

  it('skips a scrolling box with nothing to scroll for one that has', () => {
    const pane = box('auto', { scrollHeight: 3000, clientHeight: 600 });
    const inner = box('auto', { scrollHeight: 100, clientHeight: 100 });
    const el = document.createElement('div');
    inner.append(el);
    pane.append(inner);
    document.body.append(pane);
    expect(scrollerOf(el)).toBe(pane);
  });

  it('falls back to the page when nothing around it scrolls (the standalone wd page)', () => {
    const el = document.createElement('div');
    document.body.append(box('visible'));
    document.body.firstElementChild!.append(el);
    expect(scrollerOf(el)).toBe(document.scrollingElement ?? document.documentElement);
  });
});
