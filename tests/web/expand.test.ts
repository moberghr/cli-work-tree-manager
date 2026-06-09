import { describe, it, expect } from 'vitest';
import type { Hunk } from '../../src/web/src/api/client.js';
import {
  computeGaps,
  gapOffset,
  hiddenRemaining,
  nextBottomRange,
  nextTopRange,
  EXPAND_CHUNK,
} from '../../src/web/src/utils/expand.js';

function hunk(over: Partial<Hunk>): Hunk {
  return {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    context: '',
    lines: [],
    ...over,
  };
}

describe('computeGaps', () => {
  it('returns no gaps for an empty hunk list', () => {
    expect(computeGaps([])).toEqual([]);
  });

  it('emits a head gap when the first hunk starts past line 1', () => {
    const gaps = computeGaps([hunk({ oldStart: 50, newStart: 50, oldLines: 5, newLines: 5 })]);
    const head = gaps.find((g) => g.key === 'head');
    expect(head).toBeDefined();
    expect(head!.top).toBeNull();
    expect(head!.bottom).toEqual({ newNum: 50, oldNum: 50 });
  });

  it('omits the head gap when the first hunk starts at line 1', () => {
    const gaps = computeGaps([hunk({ oldStart: 1, newStart: 1 })]);
    expect(gaps.find((g) => g.key === 'head')).toBeUndefined();
  });

  it('emits a between-gap only when hunks are more than one line apart', () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, oldLines: 5, newLines: 5 }), // ends at 5
      hunk({ oldStart: 20, newStart: 20, oldLines: 3, newLines: 3 }), // starts at 20
    ];
    const mid = computeGaps(hunks).find((g) => g.key === 'mid-0');
    expect(mid).toBeDefined();
    expect(mid!.top).toEqual({ newNum: 5, oldNum: 5 });
    expect(mid!.bottom).toEqual({ newNum: 20, oldNum: 20 });
  });

  it('skips a between-gap for adjacent hunks', () => {
    const hunks = [
      hunk({ oldStart: 1, newStart: 1, oldLines: 5, newLines: 5 }), // ends at 5
      hunk({ oldStart: 6, newStart: 6, oldLines: 2, newLines: 2 }), // starts at 6
    ];
    expect(computeGaps(hunks).find((g) => g.key === 'mid-0')).toBeUndefined();
  });

  it('always emits a tail gap', () => {
    const tail = computeGaps([hunk({ newStart: 1, newLines: 3, oldStart: 1, oldLines: 3 })]).find(
      (g) => g.key === 'tail',
    );
    expect(tail).toBeDefined();
    expect(tail!.bottom).toBeNull();
    expect(tail!.top).toEqual({ newNum: 3, oldNum: 3 });
  });
});

describe('gapOffset', () => {
  it('reflects a divergence between old and new numbering above the gap', () => {
    // Lines were added earlier in the file: new side is 3 ahead of old.
    const gap = { key: 'mid-0', top: { newNum: 13, oldNum: 10 }, bottom: { newNum: 30, oldNum: 27 } };
    expect(gapOffset(gap)).toBe(-3); // oldNum = newNum - 3
  });

  it('is zero for the head gap', () => {
    expect(gapOffset({ key: 'head', top: null, bottom: { newNum: 5, oldNum: 5 } })).toBe(0);
  });
});

describe('nextTopRange / nextBottomRange', () => {
  const mid = { key: 'mid-0', top: { newNum: 5, oldNum: 5 }, bottom: { newNum: 100, oldNum: 100 } };

  it('expands downward from the top anchor in chunk-sized steps', () => {
    expect(nextTopRange(mid, 0, 0)).toEqual({ start: 6, end: 6 + EXPAND_CHUNK - 1 });
    expect(nextTopRange(mid, EXPAND_CHUNK, 0)).toEqual({
      start: 6 + EXPAND_CHUNK,
      end: 6 + 2 * EXPAND_CHUNK - 1,
    });
  });

  it('expands upward from the bottom anchor in chunk-sized steps', () => {
    expect(nextBottomRange(mid, 0, 0)).toEqual({ start: 99 - EXPAND_CHUNK + 1, end: 99 });
  });

  it('does not let top and bottom expansions overlap', () => {
    // Small gap: lines 6..9 hidden (bottom at 10).
    const small = { key: 'mid-0', top: { newNum: 5, oldNum: 5 }, bottom: { newNum: 10, oldNum: 10 } };
    // Top reveals 6..9 (clamped by ceiling), bottom then has nothing left.
    expect(nextTopRange(small, 0, 0)).toEqual({ start: 6, end: 9 });
    expect(nextBottomRange(small, 4, 0)).toBeNull();
  });

  it('tail gap expands open-ended downward', () => {
    const tail = { key: 'tail', top: { newNum: 12, oldNum: 12 }, bottom: null };
    expect(nextTopRange(tail, 0, 0)).toEqual({ start: 13, end: 13 + EXPAND_CHUNK - 1 });
    expect(nextBottomRange(tail, 0, 0)).toBeNull();
  });

  it('head gap expands upward from the first hunk', () => {
    const head = { key: 'head', top: null, bottom: { newNum: 30, oldNum: 30 } };
    expect(nextBottomRange(head, 0, 0)).toEqual({ start: 29 - EXPAND_CHUNK + 1, end: 29 });
  });
});

describe('hiddenRemaining', () => {
  const mid = { key: 'mid-0', top: { newNum: 5, oldNum: 5 }, bottom: { newNum: 30, oldNum: 30 } };
  it('counts the lines between the anchors minus what is revealed', () => {
    expect(hiddenRemaining(mid, 0, 0)).toBe(24); // 6..29
    expect(hiddenRemaining(mid, 10, 4)).toBe(10);
    expect(hiddenRemaining(mid, 24, 0)).toBe(0);
  });
  it('is null for the tail gap', () => {
    expect(hiddenRemaining({ key: 'tail', top: { newNum: 5, oldNum: 5 }, bottom: null }, 0, 0)).toBeNull();
  });
});
