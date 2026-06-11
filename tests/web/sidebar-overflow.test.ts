import { describe, it, expect } from 'vitest';
import { sidebarNeedsOwnScroller } from '../../src/web/src/hooks/use-sidebar-overflow.js';

describe('sidebarNeedsOwnScroller', () => {
  it('stays in document flow when the tree fits within the viewport', () => {
    // Content shorter than the viewport → no nested scroller, so Ctrl+F
    // ticks for file-tree matches share the viewport scrollbar.
    expect(sidebarNeedsOwnScroller(400, 800)).toBe(false);
  });

  it('becomes its own scroller only when the tree exceeds the viewport', () => {
    expect(sidebarNeedsOwnScroller(1500, 800)).toBe(true);
  });

  it('treats exact-fit as not needing a scroller (boundary)', () => {
    expect(sidebarNeedsOwnScroller(800, 800)).toBe(false);
  });
});
