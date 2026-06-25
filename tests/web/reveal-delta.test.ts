import { describe, it, expect } from 'vitest';
import { revealDelta } from '../../src/web/src/hooks/use-scrollspy.js';

// revealDelta drives the file-tree follow-scroll: as the diff scrolls and the
// scrollspy moves the active row, the sidebar nudges its own scrollTop so the
// highlighted file stays visible — without ever touching the page scroll.
describe('revealDelta', () => {
  const PAD = 24;
  const VIEW = 460; // a typical sidebar scroller height

  it('does not move when the row sits comfortably in view', () => {
    expect(revealDelta(200, 20, VIEW, PAD)).toBe(0);
  });

  it('scrolls up (negative) when the row is above the top pad', () => {
    // Row 10px below the container top, less than the 24px pad → pull it down
    // into view by scrolling the container up.
    expect(revealDelta(10, 20, VIEW, PAD)).toBe(10 - PAD); // -14
  });

  it('scrolls up when the row is fully above the visible band', () => {
    expect(revealDelta(-100, 20, VIEW, PAD)).toBe(-124);
  });

  it('scrolls down (positive) when the row is below the bottom pad', () => {
    // Row whose bottom (450 + 20 = 470) exceeds VIEW - pad (436).
    expect(revealDelta(450, 20, VIEW, PAD)).toBe(470 - (VIEW - PAD)); // 34
  });

  it('scrolls down when the row is fully below the visible band', () => {
    expect(revealDelta(600, 20, VIEW, PAD)).toBe(620 - (VIEW - PAD)); // 184
  });

  it('treats the exact pad boundary as in view', () => {
    expect(revealDelta(PAD, 20, VIEW, PAD)).toBe(0);
  });
});
