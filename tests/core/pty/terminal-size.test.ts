import { describe, expect, it } from 'vitest';
import {
  MAX_COLS,
  MAX_ROWS,
  gridFromParams,
  isWindowsPty,
  sameGrid,
  validGrid,
  windowsPtyFor,
  withGrid,
} from '../../../src/core/pty/terminal-size.js';

describe('terminal-size', () => {
  it('a valid grid is whole numbers within bounds', () => {
    expect(validGrid(120, 32)).toEqual({ cols: 120, rows: 32 });
    expect(validGrid(2, 2)).toEqual({ cols: 2, rows: 2 });
    expect(validGrid(MAX_COLS, MAX_ROWS)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
    for (const [c, r] of [
      [0, 0],
      [2, 1], // FitAddon's grid for an empty pane
      [1, 10],
      [80.5, 24],
      [MAX_COLS + 1, 24],
      [80, MAX_ROWS + 1],
      [-80, 24],
      [Number.NaN, 24],
      ['80', '24'],
      [undefined, undefined],
    ] as const) {
      expect(validGrid(c, r)).toBeNull();
    }
  });

  it('states a grid on an address, after any parameters it has, and leaves it as it is without one', () => {
    expect(withGrid('ws://h/ptys/s/attach', { cols: 80, rows: 24 })).toBe('ws://h/ptys/s/attach?cols=80&rows=24');
    expect(withGrid('ws://h/a?token=t&flow=1', { cols: 80, rows: 24 })).toBe('ws://h/a?token=t&flow=1&cols=80&rows=24');
    expect(withGrid('ws://h/a?token=t', null)).toBe('ws://h/a?token=t');
    expect(withGrid('ws://h/a?token=t', undefined)).toBe('ws://h/a?token=t');
  });

  it('reads the grid an address states back, and nothing that is not a valid one', () => {
    const read = (q: string) => gridFromParams(new URLSearchParams(q));
    expect(read(new URL(withGrid('ws://h/a?token=t', { cols: 133, rows: 41 })).search)).toEqual({ cols: 133, rows: 41 });
    expect(read('')).toBeNull();
    expect(read('cols=80')).toBeNull();
    expect(read('cols=80&rows=1')).toBeNull();
    expect(read('cols=80.0&rows=24')).toBeNull();
    expect(read('cols=0x50&rows=24')).toBeNull();
    expect(read('cols=1e2&rows=24')).toBeNull();
    expect(read('cols=99999&rows=24')).toBeNull();
    expect(read('cols=-80&rows=24')).toBeNull();
  });

  it('two grids are the same only when both exist and match', () => {
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true);
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 23 })).toBe(false);
    expect(sameGrid(null, null)).toBe(false);
    expect(sameGrid({ cols: 80, rows: 24 }, undefined)).toBe(false);
  });

  it('windowsPty on Windows is ConPTY at the OS build, as VS Code sets it; nothing anywhere else', () => {
    expect(windowsPtyFor('win32', '10.0.22631')).toEqual({ backend: 'conpty', buildNumber: 22631 });
    expect(windowsPtyFor('win32', '10.0.19045')).toEqual({ backend: 'conpty', buildNumber: 19045 });
    expect(windowsPtyFor('win32', 'garbage')).toBeUndefined();
    expect(windowsPtyFor('darwin', '25.0.0')).toBeUndefined();
    expect(windowsPtyFor('linux', '6.8.0-45-generic')).toBeUndefined();
  });

  it('a windowsPty read off the wire is shape-checked', () => {
    expect(isWindowsPty({ backend: 'conpty', buildNumber: 22631 })).toBe(true);
    expect(isWindowsPty({ backend: 'winpty', buildNumber: 22631 })).toBe(false);
    expect(isWindowsPty({ backend: 'conpty', buildNumber: '22631' })).toBe(false);
    expect(isWindowsPty({ backend: 'conpty', buildNumber: 0 })).toBe(false);
    expect(isWindowsPty(null)).toBe(false);
    expect(isWindowsPty(undefined)).toBe(false);
  });
});
