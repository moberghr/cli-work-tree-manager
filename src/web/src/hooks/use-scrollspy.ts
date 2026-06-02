import { useEffect, useState } from 'react';

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
