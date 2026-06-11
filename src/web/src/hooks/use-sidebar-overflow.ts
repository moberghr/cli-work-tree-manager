import { useEffect, useState, type RefObject } from 'react';

/**
 * Decide whether the review sidebar must become its own scroll container.
 * Kept pure + exported so the threshold is unit-testable without a layout
 * engine (jsdom reports no real geometry).
 */
export function sidebarNeedsOwnScroller(
  contentHeight: number,
  viewportHeight: number,
): boolean {
  return contentHeight > viewportHeight;
}

/**
 * True when the sidebar's natural content is taller than the viewport, so it
 * should switch from document-flow (`overflow: visible`) to an independent
 * scroller (`overflow-y: auto; height: 100vh`).
 *
 * Why measure instead of just always using `overflow: auto`: a non-overflowing
 * `overflow: auto` box is STILL a find-in-page tickmark scroller in Chrome.
 * A Ctrl+F match inside such a sidebar (e.g. a filename in the file tree)
 * belongs to that scroller, and navigating onto it wipes the *viewport*
 * scrollbar's match ticks. Keeping the sidebar `overflow: visible` until it
 * truly needs to scroll means its matches live in the document scroller and
 * the ticks stay put. Only a genuinely tall tree becomes its own scroller —
 * and then its own (now-visible) scrollbar hosts those ticks.
 *
 * `deps` should change when the rendered sidebar content identity changes
 * (e.g. the active repo) so the observer re-attaches once the element mounts.
 */
export function useSidebarOverflowsViewport(
  ref: RefObject<HTMLElement | null>,
  deps: unknown[],
): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // scrollHeight is the full content height regardless of the current
    // overflow/height — so the decision is stable across the class toggle
    // it drives (no measure/restyle feedback loop).
    const measure = () =>
      setOverflows(sidebarNeedsOwnScroller(el.scrollHeight, window.innerHeight));
    measure();
    // ResizeObserver is absent in non-browser environments (e.g. jsdom under
    // test). Fall back to the resize listener alone — measure() still ran once.
    const ro =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return overflows;
}
