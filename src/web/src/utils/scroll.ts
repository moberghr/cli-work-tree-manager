/**
 * Scrolling an element into view inside the diff — without `scrollIntoView`.
 *
 * `scrollIntoView` scrolls every ancestor, `overflow: hidden` ones included.
 * In the dashboard the diff scrolls in its own box; when that box can't go
 * further (a file near the end), the browser scrolled the boxes around it
 * instead, sliding the whole app up under a blank strip that no scrollbar
 * could undo (ticking Viewed on one of the last files did it). These scroll
 * only the element's own scroller: the nearest scrolling box, else the page
 * (the standalone `wd` page scrolls on the document).
 */

export type Block = 'start' | 'center';

/**
 * The scrollTop that puts a child at `block` in its scroller. `relTop` is the
 * child's top relative to the scroller's visible top; `margin` its
 * `scroll-margin-top` (kept free above it at `start`). Never below 0 nor past
 * the end (`maxTop`). Pure, so the arithmetic is testable without layout.
 */
export function scrollTopFor(
  current: number,
  relTop: number,
  height: number,
  viewportHeight: number,
  maxTop: number,
  margin: number,
  block: Block,
): number {
  const offset = block === 'start' ? relTop - margin : relTop - (viewportHeight - height) / 2;
  return Math.max(0, Math.min(maxTop, Math.round(current + offset)));
}

function scrolls(el: Element): boolean {
  const y = getComputedStyle(el).overflowY;
  return y === 'auto' || y === 'scroll';
}

/**
 * The box that scrolls `el`: the nearest ancestor that scrolls and has
 * something to scroll, else the nearest that scrolls (a short diff — nothing
 * moves, and nothing around it does either), else the page.
 */
export function scrollerOf(el: Element): Element {
  let fallback: Element | null = null;
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    if (!scrolls(p)) continue;
    if (p.scrollHeight > p.clientHeight) return p;
    fallback ??= p;
  }
  return fallback ?? document.scrollingElement ?? document.documentElement;
}

/** Scroll `el` to `block` in its own scroller, and nothing else. */
export function revealInScroller(el: Element, opts: { block?: Block; behavior?: ScrollBehavior } = {}): void {
  const scroller = scrollerOf(el);
  const page = scroller === document.scrollingElement || scroller === document.documentElement;
  const viewTop = page ? 0 : scroller.getBoundingClientRect().top;
  const viewHeight = page ? window.innerHeight : scroller.clientHeight;
  const rect = el.getBoundingClientRect();
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const top = scrollTopFor(
    scroller.scrollTop,
    rect.top - viewTop,
    rect.height,
    viewHeight,
    scroller.scrollHeight - viewHeight,
    margin,
    opts.block ?? 'start',
  );
  // jsdom (the tests) has no Element.scrollTo.
  if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: opts.behavior ?? 'auto' });
  else scroller.scrollTop = top;
}
