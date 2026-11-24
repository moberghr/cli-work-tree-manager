import { describe, expect, it } from 'vitest';
import { WEBGL_RETRY_MS } from '../../src/web/src/state/webgl-recovery.js';
import {
  WEBGL_RELEASE_MS,
  WebglRenderer,
  loseContexts,
  type RendererKind,
  type WebglHost,
  type WebglTimers,
} from '../../src/web/src/state/webgl-renderer.js';

/** A canvas: `kind` is the context it holds (getContext answers only that kind, as a browser does). */
class FakeCanvas {
  isConnected = true;
  lost = false;
  constructor(readonly kind: 'webgl2' | '2d' | null) {}
  getContext(kind: string) {
    if (kind !== this.kind || kind === '2d') return null;
    return {
      isContextLost: () => this.lost,
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => (this.lost = true) } : null),
    };
  }
}

class FakeAddon {
  disposed = false;
  loss: (() => void) | null = null;
  /** Its canvas, in the terminal while loaded. */
  readonly canvas = new FakeCanvas('webgl2');
  onContextLoss(cb: () => void) {
    this.loss = cb;
  }
  dispose() {
    this.disposed = true;
    this.canvas.isConnected = false;
  }
  /** The GPU took the context away (the addon reports it only after waiting for a restore). */
  lose() {
    this.canvas.lost = true;
    this.loss?.();
  }
}

/** Virtual time: `advance(ms)` fires what falls due, in order. */
function virtualTimers() {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: WebglTimers = {
    now: () => now,
    set: (fn, ms) => {
      due.set(++next, { at: now + ms, fn });
      return next;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const first = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].fn();
    }
    now = until;
  };
  return { timers, advance };
}

function setup(opts: { visible?: boolean; refusal?: string | null } = {}) {
  const addons: FakeAddon[] = [];
  const labels: RendererKind[] = [];
  let refits = 0;
  let fails = false;
  const linkLayer = new FakeCanvas('2d');
  const host: WebglHost<FakeAddon> = {
    create: () => {
      if (fails) throw new Error('WebGL2 not supported');
      const a = new FakeAddon();
      addons.push(a);
      return a;
    },
    load: () => {},
    canvases: () => [linkLayer, ...addons.filter((a) => !a.disposed).map((a) => a.canvas)] as unknown as HTMLCanvasElement[],
    label: (k) => void labels.push(k),
    refit: () => void refits++,
  };
  const t = virtualTimers();
  const r = new WebglRenderer(host, opts.visible ?? true, opts.refusal ?? null, t.timers);
  return {
    r,
    addons,
    labels,
    linkLayer,
    advance: t.advance,
    refits: () => refits,
    failing: (v: boolean) => {
      fails = v;
    },
  };
}

describe('WebglRenderer', () => {
  it('loads WebGL at once when shown', () => {
    const s = setup();
    expect(s.addons).toHaveLength(1);
    expect(s.labels).toEqual(['webgl']);
  });

  it('a software rasterizer keeps it on the DOM renderer, shown or not', () => {
    const s = setup({ refusal: 'software' });
    s.r.shown();
    expect(s.addons).toHaveLength(0);
    expect(s.labels).toEqual(['dom']);
  });

  it('no WebGL2 at all: the DOM renderer for good, nothing to wait for', () => {
    const s = setup({ visible: false });
    s.failing(true);
    s.r.shown();
    expect(s.labels).toEqual(['dom']);
    s.failing(false);
    s.r.hidden();
    s.r.shown();
    s.advance(60 * 60_000);
    expect(s.addons).toHaveLength(0);
  });

  it('opened hidden in the deck, it takes no context until shown', () => {
    const s = setup({ visible: false });
    expect(s.addons).toHaveLength(0);
    s.r.shown();
    expect(s.addons).toHaveLength(1);
  });

  it('hidden for WEBGL_RELEASE_MS, it lets its context go: the addon disposed and the context lost, not left to the GC', () => {
    const s = setup();
    s.r.hidden();
    s.advance(WEBGL_RELEASE_MS - 1);
    expect(s.addons[0].disposed).toBe(false);
    s.advance(1);
    expect(s.addons[0].disposed).toBe(true);
    expect(s.addons[0].canvas.lost).toBe(true);
    expect(s.linkLayer.lost).toBe(false);
  });

  it('shown again before that, it keeps the one it has (a quick flip makes none)', () => {
    const s = setup();
    s.r.hidden();
    s.advance(WEBGL_RELEASE_MS / 2);
    s.r.shown();
    s.advance(WEBGL_RELEASE_MS);
    expect(s.addons).toHaveLength(1);
    expect(s.addons[0].disposed).toBe(false);
  });

  it('shown after letting go, it gets a new context before the fit (no refit of its own)', () => {
    const s = setup();
    s.r.hidden();
    s.advance(WEBGL_RELEASE_MS);
    s.r.shown();
    expect(s.addons).toHaveLength(2);
    expect(s.addons[1].disposed).toBe(false);
    expect(s.labels.at(-1)).toBe('webgl');
    expect(s.refits()).toBe(0);
  });

  it('a lost context while shown: the DOM renderer, a refit, and a try again after the pause', () => {
    const s = setup();
    s.addons[0].lose();
    expect(s.addons[0].disposed).toBe(true);
    expect(s.labels.at(-1)).toBe('retrying');
    expect(s.refits()).toBe(1);
    s.advance(WEBGL_RETRY_MS[0]);
    expect(s.addons).toHaveLength(2);
    expect(s.labels.at(-1)).toBe('webgl');
    expect(s.refits()).toBe(2);
  });

  it('a try again that falls due while hidden waits for the terminal to be shown: one try then', () => {
    const s = setup();
    s.r.hidden();
    s.addons[0].lose();
    s.advance(10 * 60_000);
    expect(s.addons).toHaveLength(1);
    s.r.shown();
    expect(s.addons).toHaveLength(2);
    s.r.shown();
    expect(s.addons).toHaveLength(2);
  });

  it('shown while a try again is still waiting, it leaves the timing to the pause', () => {
    const s = setup();
    s.addons[0].lose();
    s.r.hidden();
    s.r.shown();
    expect(s.addons).toHaveLength(1);
    s.advance(WEBGL_RETRY_MS[0]);
    expect(s.addons).toHaveLength(2);
  });

  it('a new context that cannot be had once one was counts as a loss (tried again), not "no WebGL here"', () => {
    const s = setup();
    s.r.hidden();
    s.advance(WEBGL_RELEASE_MS);
    s.failing(true);
    s.r.shown();
    expect(s.labels.at(-1)).toBe('retrying');
    s.failing(false);
    s.advance(WEBGL_RETRY_MS[0]);
    expect(s.labels.at(-1)).toBe('webgl');
  });

  it('a loss reported by an addon already let go changes nothing', () => {
    const s = setup();
    s.r.hidden();
    s.advance(WEBGL_RELEASE_MS);
    s.addons[0].loss?.();
    expect(s.labels).toEqual(['webgl']);
  });

  it('gives up after losing it too often, like WebglRecovery', () => {
    const s = setup();
    for (let i = 0; i < WEBGL_RETRY_MS.length; i++) {
      s.addons.at(-1)!.lose();
      s.advance(WEBGL_RETRY_MS[i]);
    }
    s.addons.at(-1)!.lose();
    expect(s.labels.at(-1)).toBe('dom');
    s.r.hidden();
    s.r.shown();
    s.advance(60 * 60_000);
    expect(s.addons).toHaveLength(WEBGL_RETRY_MS.length + 1);
  });

  it('disposed, it lets the context go at once and never loads again', () => {
    const s = setup();
    s.addons[0].lose();
    const t = setup();
    t.r.dispose();
    expect(t.addons[0].disposed).toBe(true);
    expect(t.addons[0].canvas.lost).toBe(true);
    s.r.dispose();
    s.advance(WEBGL_RETRY_MS[0]);
    s.r.shown();
    expect(s.addons).toHaveLength(1);
  });
});

describe('loseContexts', () => {
  it('loses each live WebGL context, leaving 2D canvases, empty ones and lost ones alone', () => {
    const gl = new FakeCanvas('webgl2');
    const lost = new FakeCanvas('webgl2');
    lost.lost = true;
    const canvases = [gl, lost, new FakeCanvas('2d'), new FakeCanvas(null)] as unknown as HTMLCanvasElement[];
    expect(loseContexts(canvases)).toBe(1);
    expect(gl.lost).toBe(true);
  });
});
