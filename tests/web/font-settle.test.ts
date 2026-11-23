import { describe, expect, it, vi } from 'vitest';
import {
  FONT_SETTLE_MS,
  fontFamilies,
  onFontsSettled,
  touchesStack,
  type FaceLike,
  type SettleTimers,
} from '../../src/web/src/state/font-settle.js';

const STACK = '"Cascadia Code", "Cascadia Mono", SFMono-Regular, Consolas, monospace';

describe('fontFamilies', () => {
  it('unquotes, trims and lower-cases each family', () => {
    expect(fontFamilies(STACK)).toEqual(['cascadia code', 'cascadia mono', 'sfmono-regular', 'consolas', 'monospace']);
    expect(fontFamilies(" 'JetBrains Mono' ,, ")).toEqual(['jetbrains mono']);
  });
});

describe('touchesStack', () => {
  it('is true when a face is one of the stack families, however it is quoted or cased', () => {
    expect(touchesStack([{ family: 'Inter' }, { family: '"cascadia code"' }], STACK)).toBe(true);
    expect(touchesStack([{ family: 'Inter' }], STACK)).toBe(false);
    expect(touchesStack([], STACK)).toBe(false);
  });
});

/** Timers run by hand: `run()` fires what is due. */
function manualTimers() {
  const due = new Map<number, () => void>();
  let next = 0;
  const timers: SettleTimers = {
    set: (fn) => {
      due.set(++next, fn);
      return next;
    },
    clear: (h) => void due.delete(h as number),
  };
  const run = () => {
    const fns = [...due.values()];
    due.clear();
    for (const fn of fns) fn();
  };
  return { timers, run, pending: () => due.size };
}

function fakeFonts(faces: FaceLike[]) {
  let resolve!: () => void;
  const listeners = new Set<(e: Event) => void>();
  const fonts = {
    ready: new Promise<void>((r) => (resolve = r)),
    [Symbol.iterator]: () => faces[Symbol.iterator](),
    addEventListener: (_t: 'loadingdone', fn: (e: Event) => void) => void listeners.add(fn),
    removeEventListener: (_t: 'loadingdone', fn: (e: Event) => void) => void listeners.delete(fn),
  };
  const done = (families: string[]) => {
    const e = Object.assign(new Event('loadingdone'), { fontfaces: families.map((family) => ({ family })) });
    for (const fn of listeners) fn(e);
  };
  return { fonts, ready: () => resolve(), done, listeners };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('onFontsSettled', () => {
  it('does nothing without a font set', () => {
    const remeasure = vi.fn();
    onFontsSettled(undefined, () => STACK, remeasure)();
    expect(remeasure).not.toHaveBeenCalled();
  });

  it('measures again once ready when a face of the stack that was loading at the open has loaded', async () => {
    const face = { family: 'Cascadia Code', status: 'loading' };
    const f = fakeFonts([face]);
    const t = manualTimers();
    const remeasure = vi.fn();
    onFontsSettled(f.fonts, () => STACK, remeasure, t.timers);
    face.status = 'loaded';
    f.ready();
    await flush();
    t.run();
    expect(remeasure).toHaveBeenCalledOnce();
  });

  it('does not measure again on ready for faces loaded before the open, or for other families', async () => {
    const f = fakeFonts([
      { family: 'Cascadia Code', status: 'loaded' },
      { family: 'Inter', status: 'loading' },
    ]);
    const t = manualTimers();
    const remeasure = vi.fn();
    onFontsSettled(f.fonts, () => STACK, remeasure, t.timers);
    f.ready();
    await flush();
    expect(t.pending()).toBe(0);
    expect(remeasure).not.toHaveBeenCalled();
  });

  it('measures once for a burst of loads of the stack, after FONT_SETTLE_MS, and never for another family', () => {
    const f = fakeFonts([]);
    const set = vi.fn<SettleTimers['set']>((fn) => setTimeout(fn, 0));
    const remeasure = vi.fn();
    vi.useFakeTimers();
    try {
      onFontsSettled(f.fonts, () => STACK, remeasure, { set, clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) });
      f.done(['Inter']);
      expect(set).not.toHaveBeenCalled();
      f.done(['Cascadia Code']);
      f.done(['Cascadia Mono']);
      expect(set).toHaveBeenCalledOnce();
      expect(set.mock.calls[0][1]).toBe(FONT_SETTLE_MS);
      vi.runAllTimers();
      expect(remeasure).toHaveBeenCalledOnce();
      f.done(['Cascadia Code']);
      vi.runAllTimers();
      expect(remeasure).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads the stack when the faces arrive (it may have changed since)', () => {
    const f = fakeFonts([]);
    const t = manualTimers();
    const remeasure = vi.fn();
    let stack = 'monospace';
    onFontsSettled(f.fonts, () => stack, remeasure, t.timers);
    stack = STACK;
    f.done(['Cascadia Code']);
    t.run();
    expect(remeasure).toHaveBeenCalledOnce();
  });

  it('stopped, it drops a pending measure and stops listening', async () => {
    const face = { family: 'Cascadia Code', status: 'loading' };
    const f = fakeFonts([face]);
    const t = manualTimers();
    const remeasure = vi.fn();
    const stop = onFontsSettled(f.fonts, () => STACK, remeasure, t.timers);
    f.done(['Cascadia Code']);
    stop();
    expect(t.pending()).toBe(0);
    expect(f.listeners.size).toBe(0);
    face.status = 'loaded';
    f.ready();
    await flush();
    t.run();
    expect(remeasure).not.toHaveBeenCalled();
  });
});
