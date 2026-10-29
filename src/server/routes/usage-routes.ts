import fs from 'node:fs';
import type { Hono } from 'hono';
import { report } from '../../core/platform/report.js';
import { createFsWatcher, type FsWatcher } from '../../core/platform/fs-watcher.js';
import { usageDir } from '../../core/usage/usage-store.js';
import type { UsageWire } from '../../core/api-types.js';

/**
 * GET /api/usage (core/usage/): each agent's plan limits as its hooks last
 * recorded them, and the tokens its sessions used. A read: nothing is
 * fetched or started. The readings change in ~/.work/usage (the status-line
 * hook writes them from any `work` process), so watchUsage turns a change
 * there into a `usage-changed` event.
 */
/** How long an answer is reused: every window asks on each usage-changed, and an answer reads every live session's transcripts. */
const FRESH_MS = 5000;

/**
 * One build shared by every caller, reused for `ttlMs`; `invalidate` (a new reading) makes the next caller build
 * again. Not stale-while-revalidate like createSharedFetch: the SPA asks only on an event, so a stale answer would
 * stay on screen until the next one.
 */
export function createUsageCache<T>(build: () => Promise<T>, ttlMs = FRESH_MS, now: () => number = Date.now) {
  let last: { at: number; gen: number; value: T } | null = null;
  let inFlight: { gen: number; p: Promise<T> } | null = null;
  let gen = 0;
  return {
    get(): Promise<T> {
      if (last && last.gen === gen && now() - last.at < ttlMs) return Promise.resolve(last.value);
      if (inFlight && inFlight.gen === gen) return inFlight.p;
      const mine = gen;
      const p = build().then((value) => {
        // A build started before a new reading answers its callers but isn't kept.
        if (mine === gen) last = { at: now(), gen: mine, value };
        return value;
      });
      const flight = { gen: mine, p };
      inFlight = flight;
      void p.then(
        () => (inFlight === flight ? (inFlight = null) : undefined),
        () => (inFlight === flight ? (inFlight = null) : undefined),
      );
      return p;
    },
    invalidate(): void {
      gen++;
    },
  };
}

export function mountUsageRoutes(
  app: Hono,
  opts: { broadcast: (event: string, data: unknown) => void; build: () => Promise<UsageWire> },
): void {
  app.get('/api/usage', async (c) => {
    try {
      return c.json(await opts.build());
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      report('warn', `[usage] GET /api/usage failed: ${why}`);
      return c.json({ error: why }, 500);
    }
  });
}

/** At most one event per this long: a busy session rewrites its reading as the percent moves. */
const THROTTLE_MS = 2000;

/** Watch the readings folder; the first change broadcasts at once, the rest of a burst once at its end. */
export function watchUsage(opts: {
  broadcast: (event: string, data: unknown) => void;
  /** Every change, before the throttle: the cached answer is old at once. */
  onChange?: () => void;
  throttleMs?: number;
  dir?: string;
}): FsWatcher {
  const throttleMs = opts.throttleMs ?? THROTTLE_MS;
  const dir = opts.dir ?? usageDir();
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  const send = () => {
    last = Date.now();
    opts.broadcast('usage-changed', { ts: last });
  };
  const onChange = () => {
    opts.onChange?.();
    if (timer) return;
    const wait = last + throttleMs - Date.now();
    if (wait <= 0) return send();
    timer = setTimeout(() => {
      timer = null;
      send();
    }, wait);
    timer.unref?.();
  };
  let watcher: FsWatcher | null = null;
  try {
    // Made here, at mount: a watch needs the folder, and a GET must create nothing.
    fs.mkdirSync(dir, { recursive: true });
    watcher = createFsWatcher({ roots: [dir], onChange });
  } catch (e) {
    report('warn', `[usage] not watching ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return {
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.stop();
    },
  };
}

/**
 * What work web wires: GET /api/usage over one shared build, and the readings folder's watch, which drops that build
 * (a new reading is never hidden behind the cache) and broadcasts `usage-changed`. The watcher's stop is the caller's.
 */
export function wireUsage(
  app: Hono,
  opts: {
    broadcast: (event: string, data: unknown) => void;
    build: () => Promise<UsageWire>;
    ttlMs?: number;
    dir?: string;
    throttleMs?: number;
  },
): FsWatcher {
  const cache = createUsageCache(opts.build, opts.ttlMs);
  mountUsageRoutes(app, { broadcast: opts.broadcast, build: () => cache.get() });
  return watchUsage({ broadcast: opts.broadcast, onChange: () => cache.invalidate(), dir: opts.dir, throttleMs: opts.throttleMs });
}
