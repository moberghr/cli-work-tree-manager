import { useEffect, useRef, type RefObject } from 'react';

/** Every inline comment thread in the diff, in document order. */
const THREAD = '.wd-comment-row';

/**
 * `]` / `[` — jump to the next / previous comment thread in the diff and
 * flash it. (`j` / `k` already move between sessions.) Walks from the
 * last thread jumped to while it is still on screen, else from the top.
 */
export function useCommentJump(containerRef: RefObject<HTMLElement | null>): void {
  const current = useRef<Element | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ']' && e.key !== '[') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const root = containerRef.current;
      if (!root) return;
      const threads = [...root.querySelectorAll(THREAD)];
      if (threads.length === 0) return;
      e.preventDefault();
      const at = current.current ? threads.indexOf(current.current) : -1;
      const next =
        e.key === ']'
          ? threads[at < 0 ? 0 : (at + 1) % threads.length]
          : threads[at < 0 ? threads.length - 1 : (at - 1 + threads.length) % threads.length];
      current.current = next;
      next.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      next.classList.add('wd-row-flash');
      setTimeout(() => next.classList.remove('wd-row-flash'), 1200);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [containerRef]);
}
