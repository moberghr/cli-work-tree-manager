import { useEffect, useState, type RefObject } from 'react';

/**
 * How far to nudge a scroll container's `scrollTop` so a child row becomes
 * visible with `pad` px of breathing room. `relTop` is the child's top edge
 * relative to the container's visible top (i.e. `childRect.top -
 * containerRect.top`). Returns a positive delta to scroll down, negative to
 * scroll up, and 0 when the row is already comfortably in view.
 *
 * Pure (no DOM) so the file-tree follow-scroll behaviour is unit-testable
 * without a layout engine — mirrors `sidebarNeedsOwnScroller`.
 */
export function revealDelta(
  relTop: number,
  childHeight: number,
  viewportHeight: number,
  pad: number,
): number {
  const relBottom = relTop + childHeight;
  if (relTop < pad) return relTop - pad;
  if (relBottom > viewportHeight - pad) return relBottom - (viewportHeight - pad);
  return 0;
}

/**
 * Keep the scrollspy-highlighted file (`.wd-tree-file-active`) visible inside
 * the sidebar as the diff scrolls and `activeAnchor` moves. Adjusts ONLY the
 * sidebar's own `scrollTop` — never `scrollIntoView`, which would also scroll
 * the diff/page and make it jump.
 *
 * `enabled` lets the caller gate it to when the sidebar is actually its own
 * scroller: `ReviewApp`'s page layout only overflows on a tall tree, while the
 * dashboard's `DiffView` sidebar always scrolls (so it passes `true`).
 */
export function useFollowActiveInSidebar(
  sidebarRef: RefObject<HTMLElement | null>,
  activeAnchor: string | null,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled || !activeAnchor) return;
    const aside = sidebarRef.current;
    if (!aside) return;
    const item = aside.querySelector<HTMLElement>('.wd-tree-file-active');
    if (!item) return;
    const relTop =
      item.getBoundingClientRect().top - aside.getBoundingClientRect().top;
    aside.scrollTop += revealDelta(relTop, item.offsetHeight, aside.clientHeight, 24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAnchor, enabled]);
}

/**
 * IntersectionObserver-based scrollspy. Watches every `article.wd-file`
 * inside `containerSelector` and returns the anchor id of the file
 * currently dominating the viewport (the topmost one whose top edge is
 * above the viewport's upper threshold).
 *
 * Re-attaches when `key` changes (e.g. switching repos or sessions). Pass
 * the active repo's name or session id so the spy doesn't get confused
 * between unmounts.
 */
export function useScrollspy(key: string): string | null {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const articles = Array.from(
      document.querySelectorAll<HTMLElement>('article.wd-file'),
    );
    if (articles.length === 0) {
      setActive(null);
      return;
    }

    // Map element → its anchor id, ordered by document position.
    const ordered = articles.map((el) => ({ el, id: el.id }));

    function recompute() {
      // The "active" file is the lowest-positioned article whose top is at
      // or above the sticky-header line (~80px down from the top of the
      // scroll container). If nothing's reached that line yet, default to
      // the first article.
      const TRIGGER = 80;
      let chosen: { el: HTMLElement; id: string } | null = null;
      for (const item of ordered) {
        const rect = item.el.getBoundingClientRect();
        if (rect.top <= TRIGGER) chosen = item;
        else break;
      }
      setActive((chosen ?? ordered[0]).id);
    }

    // Recompute on every scroll/resize via a single RAF-throttled handler.
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        recompute();
      });
    }

    recompute();
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onScroll);
    };
  }, [key]);

  return active;
}
