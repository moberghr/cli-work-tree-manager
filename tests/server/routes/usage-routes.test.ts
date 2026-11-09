import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createUsageCache, mountUsageRoutes, watchUsage, wireUsage } from '../../../src/server/routes/usage-routes.js';
import { collectingReporter, withReporter } from '../../../src/core/platform/report.js';
import type { UsageWire } from '../../../src/core/api-types.js';
import type { UsageAccount } from '../../../src/core/usage/usage.js';

const wire: UsageWire = {
  agents: [],
  tokens: { today: { input: 1, cached: 0, output: 2 }, week: { input: 3, cached: 0, output: 4 }, byModel: [], topSessions: [] },
  at: '2026-10-29T10:00:00.000Z',
};

describe('GET /api/usage', () => {
  it('answers what build gives', async () => {
    const app = new Hono();
    mountUsageRoutes(app, { broadcast: () => {}, build: async () => wire });
    const r = await app.request('/api/usage');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(wire);
  });

  it('a failure is a 500 with its message', async () => {
    const app = new Hono();
    mountUsageRoutes(app, {
      broadcast: () => {},
      build: async () => {
        throw new Error('transcripts unreadable');
      },
    });
    const rep = collectingReporter();
    const r = await withReporter(rep, () => app.request('/api/usage'));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'transcripts unreadable' });
    expect(rep.entries).toEqual([{ level: 'warn', text: '[usage] GET /api/usage failed: transcripts unreadable' }]);
  });
});

describe('createUsageCache', () => {
  const counting = () => {
    let n = 0;
    return { build: async () => ++n, count: () => n };
  };

  it('two GETs within its freshness build once', async () => {
    const b = counting();
    const app = new Hono();
    const cache = createUsageCache(async () => ({ ...wire, at: String(await b.build()) }), 5000);
    mountUsageRoutes(app, { broadcast: () => {}, build: () => cache.get() });
    await app.request('/api/usage');
    await app.request('/api/usage');
    expect(b.count()).toBe(1);
  });

  it('a new reading (invalidate) builds again at once; past its freshness too', async () => {
    let t = 0;
    const b = counting();
    const cache = createUsageCache(b.build, 5000, () => t);
    expect(await cache.get()).toBe(1);
    expect(await cache.get()).toBe(1);
    cache.invalidate();
    expect(await cache.get()).toBe(2);
    t = 5000;
    expect(await cache.get()).toBe(3);
  });

  it('callers at once share one build', async () => {
    const b = counting();
    const cache = createUsageCache(b.build, 5000);
    expect(await Promise.all([cache.get(), cache.get()])).toEqual([1, 1]);
    expect(b.count()).toBe(1);
  });

  it('a build that started before a new reading is not kept', async () => {
    let release!: () => void;
    let n = 0;
    const cache = createUsageCache(() => (++n === 1 ? new Promise<number>((r) => (release = () => r(1))) : Promise.resolve(n)), 5000);
    const first = cache.get();
    cache.invalidate();
    release();
    expect(await first).toBe(1);
    expect(await cache.get()).toBe(2);
  });

  it('a failure is not kept', async () => {
    let n = 0;
    const cache = createUsageCache(async () => {
      if (++n === 1) throw new Error('nope');
      return n;
    }, 5000);
    await expect(cache.get()).rejects.toThrow('nope');
    expect(await cache.get()).toBe(2);
  });
});

/** The watcher's debounce (fs-watcher.ts) plus room: a write sooner than this after the last one postpones the event. */
const SETTLE_MS = 500;

/**
 * Keep writing until `cond` holds: a watcher arms after it's made (chokidar ignores what was there at its start), and
 * a write before that is never seen. No fixed sleep: `cond` is polled, and each write after a quiet spell is another
 * chance once it's armed.
 */
async function writeUntil(write: () => void, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    write();
    const wrote = Date.now();
    while (Date.now() - wrote < SETTLE_MS) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  return cond();
}
const writeJson = (file: string) => {
  let i = 0;
  return () => fs.writeFileSync(file, JSON.stringify({ i: ++i }));
};

describe('watchUsage', () => {
  let dir: string;
  let watcher: { stop(): void } | null = null;
  afterEach(() => {
    watcher?.stop();
    watcher = null;
    fs.rmSync(path.dirname(dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const newDir = () => (dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-watch-')), 'usage'));

  it('creates the folder, and broadcasts usage-changed when a reading is written', async () => {
    newDir();
    const events: string[] = [];
    watcher = watchUsage({ broadcast: (e) => events.push(e), dir, throttleMs: 300 });
    expect(fs.existsSync(dir)).toBe(true);
    expect(await writeUntil(writeJson(path.join(dir, 'claude-default.json')), () => events.length > 0)).toBe(true);
    expect(new Set(events)).toEqual(new Set(['usage-changed']));
  });

  it('a burst of changes is one event at once and one at its end (throttled)', async () => {
    newDir();
    const events: number[] = [];
    let changes = 0;
    watcher = watchUsage({ broadcast: () => events.push(Date.now()), onChange: () => changes++, dir, throttleMs: 400 });
    const file = path.join(dir, 'claude-default.json');
    expect(await writeUntil(writeJson(file), () => events.length > 0)).toBe(true);
    // Armed: a burst now.
    const seen = changes;
    for (let i = 0; i < 5; i++) fs.writeFileSync(file, JSON.stringify({ burst: i }));
    const start = Date.now();
    while (changes === seen && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 25));
    expect(changes).toBeGreaterThan(seen);
    const before = events.length;
    while (events.length === before && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 25));
    // The burst's broadcast came, once, at least the throttle after the first.
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)! - events[0]!).toBeGreaterThanOrEqual(350);
  });

  it('calls onChange on a change, so the cached answer is dropped', async () => {
    newDir();
    let changes = 0;
    watcher = watchUsage({ broadcast: () => {}, onChange: () => changes++, dir, throttleMs: 300 });
    expect(await writeUntil(writeJson(path.join(dir, 'claude-default.json')), () => changes > 0)).toBe(true);
  });
});

describe('wireUsage (what work web mounts)', () => {
  let home: string;
  let watcher: { stop(): void } | null = null;
  afterEach(() => {
    watcher?.stop();
    watcher = null;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('a new reading shows in the next GET at once, though the answer is cached for a minute', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-wire-'));
    const dir = path.join(home, 'usage');
    const read = (): UsageAccount[] => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, 'claude-default.json'), 'utf-8')) as UsageAccount];
      } catch {
        return [];
      }
    };
    let builds = 0;
    const app = new Hono();
    const broadcasts: string[] = [];
    watcher = wireUsage(app, {
      broadcast: (e) => broadcasts.push(e),
      build: async () => (builds++, { ...wire, agents: [{ agent: 'claude', name: 'Claude Code', accounts: read() }] }),
      ttlMs: 60_000,
      dir,
      throttleMs: 50,
    });
    const percent = async () => {
      const w = (await (await app.request('/api/usage')).json()) as UsageWire;
      return w.agents[0]!.accounts[0]?.windows[0]?.usedPercent ?? null;
    };
    expect(await percent()).toBeNull();
    expect(await percent()).toBeNull();
    expect(builds).toBe(1); // cached

    const reading = (pct: number) => ({
      account: 'default',
      at: 'x',
      windows: [{ id: 'five_hour', label: '5h', usedPercent: pct, resetsAt: null }],
    });
    let n = 0;
    const file = path.join(dir, 'claude-default.json');
    let got: number | null = null;
    // Written until the watch is armed and the GET shows the number (from a rebuilt answer: the cached one has none).
    await writeUntil(
      () => fs.writeFileSync(file, JSON.stringify(reading(++n))),
      async () => (got = await percent()) !== null,
    );
    expect(got).not.toBeNull();
    expect(builds).toBeGreaterThan(1);
    expect(broadcasts).toContain('usage-changed');
  });
});
