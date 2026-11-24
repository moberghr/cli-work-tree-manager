/**
 * xterm or libghostty-vt? Measures the PTY host's two screen copies (`ScreenMirror`, @xterm/headless, and
 * `GhosttyMirror`, libghostty-vt's wasm build) on identical input, built directly (not through
 * WORK_TERMINAL_ENGINE), so the owner can pick which one to keep:
 *
 *   1 throughput   — MiB/s over five corpora (build log, plain text, an Ink agent's redraws, a full-screen TUI,
 *                    Unicode), 16 KiB chunks, each write awaited; fresh mirror per run, warm-up first, order alternated
 *   2 snapshot     — time and size at 0 / 200 / 1000 / 2000 / 5000 lines of scrollback, and on the alternate screen
 *   3 memory       — RSS and heap per mirror (1 and 20), each case in a child process after gc
 *   4 construction — create + dispose, and the first (cold, wasm compile included) mirror in a fresh child
 *   5 loop stalls  — the longest write and the longest event-loop delay while feeding a build log (one loop runs
 *                    every session)
 *   6 fidelity     — each snapshot replayed into a fresh xterm.js terminal (Unicode 11, as the browser) against the
 *                    engine's own screen, and the two engines' screens against each other
 *
 *   npx tsx scripts/terminal-engines.ts [--out .bench] [--quick]
 *
 * Writes <out>/terminal-engines.json and prints a compact table. `--quick` shrinks everything (smoke test, < 20 s).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import xtermHeadless from '@xterm/headless';
import xtermUnicode11 from '@xterm/addon-unicode11';
import { GhosttyMirror } from '../src/core/pty/ghostty-mirror.js';
import type { TerminalMirror } from '../src/core/pty/mirror.js';
import { REPLAY_SCROLLBACK } from '../src/core/pty/scrollback.js';
import { ScreenMirror } from '../src/core/pty/screen-mirror.js';

const { Terminal } = xtermHeadless;
const { Unicode11Addon } = xtermUnicode11;

type EngineName = 'xterm' | 'ghostty';
const ENGINES: readonly EngineName[] = ['xterm', 'ghostty'];
type PerEngine<T> = Record<EngineName, T>;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const arg = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const QUICK = flag('quick');
const OUT = path.resolve(arg('out', '.bench'));

const CHUNK = 16 * 1024;
const COLS = 200;
const ROWS = 50;
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const make = (engine: EngineName, cols: number, rows: number, scrollback: number): TerminalMirror =>
  engine === 'ghostty' ? new GhosttyMirror(cols, rows, scrollback) : new ScreenMirror(cols, rows, scrollback);

/** `gc()` without needing --expose-gc on the parent. */
const gc: () => void =
  typeof globalThis.gc === 'function'
    ? globalThis.gc
    : (() => {
        v8.setFlagsFromString('--expose-gc');
        const f: unknown = vm.runInNewContext('gc');
        return typeof f === 'function' ? () => void f() : () => {};
      })();

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const stats = (xs: number[]) => ({ median: r2(median(xs)), min: r2(Math.min(...xs)), max: r2(Math.max(...xs)), runs: xs.length });

/** Alternate who goes first, so neither engine always follows (or precedes) the other. */
const order = (i: number): EngineName[] => (i % 2 === 0 ? ['xterm', 'ghostty'] : ['ghostty', 'xterm']);

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 16 KiB pieces (in characters), never between a surrogate pair. */
function chunked(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    let end = Math.min(s.length, i + CHUNK);
    if (end < s.length && s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff) end++;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

const parsed = (m: TerminalMirror, data: string) => new Promise<void>((res) => m.write(data, res));
async function feed(m: TerminalMirror, chunks: string[]): Promise<void> {
  for (const c of chunks) await parsed(m, c);
}
async function timedFeed(m: TerminalMirror, chunks: string[]): Promise<number> {
  const t0 = performance.now();
  await feed(m, chunks);
  return performance.now() - t0;
}
/** Every chunk written at once, then the last one awaited: how the host feeds it (PTY reads don't wait for a parse). */
async function timedPipelined(m: TerminalMirror, chunks: string[]): Promise<number> {
  const t0 = performance.now();
  const last = chunks.length - 1;
  for (let i = 0; i < last; i++) m.write(chunks[i]);
  await parsed(m, chunks[last]);
  return performance.now() - t0;
}

// ---------------------------------------------------------------------------------------------------------------
// Corpora (deterministic)

const WORDS = (
  'compile link resolve cache module bundle worker session socket render parse emit queue flush retry timeout ' +
  'watch lint test deploy build target config schema router handler token stream buffer frame chunk batch'
).split(' ');
const word = (r: () => number) => WORDS[Math.floor(r() * WORDS.length)];
const words = (r: () => number, n: number) => Array.from({ length: n }, () => word(r)).join(' ');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function buildLogLine(i: number, r: () => number): string {
  const levels: [string, number][] = [
    ['INFO', 34],
    ['WARN', 33],
    ['ERROR', 31],
    ['DEBUG', 90],
  ];
  const [lvl, col] = levels[Math.floor(r() * 4)];
  const ts = `\x1b[38;5;${240 + (i % 16)}m${pad(i % 24)}:${pad(i % 60)}:${pad((i * 7) % 60)}.${pad(Math.floor(r() * 1000), 3)}\x1b[0m`;
  const rgb = `\x1b[38;2;${Math.floor(r() * 256)};${Math.floor(r() * 256)};${Math.floor(r() * 256)}m`;
  const file = `${rgb}src/${word(r)}/${word(r)}.ts:${Math.floor(r() * 900)}\x1b[0m`;
  const mark = ['', ' ✓', ' ⚠️', ' 🚀', ' ✅'][Math.floor(r() * 5)];
  const tree = r() < 0.15 ? `${r() < 0.5 ? '├── ' : '└── '}` : r() < 0.1 ? '│   ' : '';
  const bg = r() < 0.1 ? `\x1b[48;5;${16 + Math.floor(r() * 216)}m` : '';
  return `${ts} \x1b[1;${col}m${lvl.padEnd(5)}\x1b[0m ${file} ${tree}${bg}${words(r, 4 + Math.floor(r() * 12))}${mark}\x1b[0m\r\n`;
}

function buildLog(bytes: number, lines?: number): string {
  const r = mulberry32(1);
  const out: string[] = [];
  let n = 0;
  for (let i = 0; lines === undefined ? n < bytes : i < lines; i++) {
    const l = buildLogLine(i, r);
    out.push(l);
    n += l.length;
  }
  return out.join('');
}

function plain(bytes: number): string {
  const r = mulberry32(2);
  const out: string[] = [];
  let n = 0;
  while (n < bytes) {
    const l = `${words(r, 40 + Math.floor(r() * 50))}\r\n`;
    out.push(l);
    n += l.length;
  }
  return out.join('');
}

function agentRedraw(bytes: number): string {
  const r = mulberry32(3);
  const spin = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const N = 20;
  const out: string[] = ['\r\n'.repeat(30)];
  let n = 0;
  for (let f = 0; n < bytes; f++) {
    const lines: string[] = [];
    for (let i = 0; i < N; i++) {
      const colour =
        i % 3 === 0 ? `\x1b[38;2;${100 + ((f + i) % 150)};${120 + i * 5};${200 - i * 4}m` : `\x1b[38;5;${30 + ((f + i) % 200)}m`;
      const head = i === N - 1 ? `\x1b[1;36m${spin[f % spin.length]}\x1b[0m ` : '  ';
      lines.push(`${head}${colour}${words(r, 6 + (i % 9))} ${(f * 17 + i) % 1000}\x1b[0m`);
    }
    const frame =
      '\x1b[?2026h' +
      `\x1b[2K\x1b[1A`.repeat(N) +
      '\x1b[2K\x1b[G' +
      lines.join('\r\n') +
      `\r\n\x1b[2m(esc to interrupt · ${f}s)\x1b[0m` +
      '\x1b[?2026l';
    out.push(frame);
    n += frame.length;
  }
  return out.join('');
}

function tui(bytes: number, cols: number, rows: number): string {
  const r = mulberry32(4);
  const out: string[] = ['\x1b[?1049h\x1b[2J\x1b[?25l'];
  let n = 0;
  for (let f = 0; n < bytes; f++) {
    const parts: string[] = [];
    for (let y = 1; y < rows; y++) {
      const hot = (y + f) % rows;
      const body = `${words(r, 18)} ${'.'.repeat(cols)}`.slice(0, cols - 12).padEnd(cols - 12);
      const bar = `\x1b[38;2;${(y * 5) % 256};${200 - y};${(f * 3) % 256}m${'█'.repeat(1 + (hot % 10))}\x1b[0m`;
      const sel = y === (f % (rows - 1)) + 1 ? '\x1b[7m' : '\x1b[0m';
      parts.push(`\x1b[${y};1H${sel}${body}\x1b[0m ${bar}${' '.repeat(10 - (1 + (hot % 10)))}\x1b[K`);
    }
    parts.push(`\x1b[${rows};1H\x1b[7m ${('frame ' + f).padEnd(cols - 1)}\x1b[0m`);
    const frame = parts.join('');
    out.push(frame);
    n += frame.length;
  }
  return out.join('');
}

function unicodeText(bytes: number): string {
  const r = mulberry32(5);
  const pieces = [
    '日本語のテキストと中文字符串，한국어 문장입니다。',
    '👨‍👩‍👧‍👦 👩🏽‍💻 🏳️‍🌈 ❤️ ✔️ ☺️ 🚀 👍🏿 🇭🇷🇯🇵',
    'é ä ñ Z͑ͫ̓ͪ̂ͫ̽ ū́',
    'Ｆｕｌｌｗｉｄｔｈ ｔｅｘｔ ａｎｄ ｈａｌｆ－ｗｉｄｔｈ ｶﾀｶﾅ',
    '├── src │ └── lib ─┼─ ┌──┐ ░▒▓█',
    'Ελληνικά, русский, العربية, עברית, हिन्दी',
  ];
  const out: string[] = [];
  let n = 0;
  while (n < bytes) {
    let l = '';
    const k = 4 + Math.floor(r() * 8);
    for (let i = 0; i < k; i++) l += `${pieces[Math.floor(r() * pieces.length)]} `;
    if (r() < 0.3) l = `\x1b[38;5;${Math.floor(r() * 256)}m${l}\x1b[0m`;
    l += '\r\n';
    out.push(l);
    n += l.length;
  }
  return out.join('');
}

type CorpusName = 'build-log' | 'plain' | 'agent-redraw' | 'tui' | 'unicode';
const CORPUS_NAMES: readonly CorpusName[] = ['build-log', 'plain', 'agent-redraw', 'tui', 'unicode'];

function corpus(name: CorpusName, bytes: number, cols: number, rows: number): string {
  switch (name) {
    case 'build-log':
      return buildLog(bytes);
    case 'plain':
      return plain(bytes);
    case 'agent-redraw':
      return agentRedraw(bytes);
    case 'tui':
      return tui(bytes, cols, rows);
    case 'unicode':
      return unicodeText(bytes);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Sizes

const BYTES = QUICK ? 512 * 1024 : 6 * MIB;
const FIDELITY_BYTES = QUICK ? 128 * 1024 : 1 * MIB;
const RUNS = QUICK ? 2 : 5;
const SNAP_REPS = QUICK ? 3 : 9;
const CONSTRUCT_REPS = QUICK ? 10 : 50;
const MEM_REPEATS = QUICK ? 1 : 3;
const COLD_REPEATS = QUICK ? 2 : 5;
const STALL_RUNS = QUICK ? 1 : 3;
const SCROLL_LINES = 5100;

// ---------------------------------------------------------------------------------------------------------------
// 1 Throughput

interface ThroughputCase {
  corpus: CorpusName;
  cols: number;
  rows: number;
}
const THROUGHPUT_CASES: ThroughputCase[] = [
  ...CORPUS_NAMES.map((c) => ({ corpus: c, cols: COLS, rows: ROWS })),
  { corpus: 'build-log', cols: 80, rows: 24 },
];

async function throughput(): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const c of THROUGHPUT_CASES) {
    const text = corpus(c.corpus, BYTES, c.cols, c.rows);
    const bytes = Buffer.byteLength(text);
    const chunks = chunked(text);
    const ms: PerEngine<number[]> = { xterm: [], ghostty: [] };
    const piped: PerEngine<number[]> = { xterm: [], ghostty: [] };
    for (let i = -1; i < RUNS; i++) {
      for (const e of order(Math.max(i, 0))) {
        for (const mode of ['awaited', 'pipelined'] as const) {
          gc();
          const m = make(e, c.cols, c.rows, REPLAY_SCROLLBACK);
          const t = await (mode === 'awaited' ? timedFeed : timedPipelined)(m, chunks);
          m.dispose();
          if (i >= 0) (mode === 'awaited' ? ms : piped)[e].push(t);
        }
      }
    }
    const row: Record<string, unknown> = { corpus: c.corpus, grid: `${c.cols}x${c.rows}`, bytes };
    for (const e of ENGINES) {
      const mibs = ms[e].map((t) => bytes / MIB / (t / 1000));
      row[e] = {
        mibPerS: stats(mibs),
        msPerMiB: stats(ms[e].map((t) => t / (bytes / MIB))),
        pipelinedMibPerS: stats(piped[e].map((t) => bytes / MIB / (t / 1000))),
      };
    }
    results.push(row);
    console.error(`  throughput ${c.corpus} ${c.cols}x${c.rows} done`);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// 2 Snapshot

const SNAP_LIMITS = [0, 200, 1000, 2000, 5000];

async function snapshots(): Promise<unknown[]> {
  const fill = chunked(buildLog(0, SCROLL_LINES));
  const cases: { label: string; limit: number; opts: { scrollback: boolean }; alt: boolean }[] = [
    { label: '0 (screen only)', limit: REPLAY_SCROLLBACK, opts: { scrollback: false }, alt: false },
    ...SNAP_LIMITS.filter((l) => l > 0).map((l) => ({ label: String(l), limit: l, opts: { scrollback: true }, alt: false })),
    { label: 'alt screen + 2000 beneath', limit: REPLAY_SCROLLBACK, opts: { scrollback: true }, alt: true },
  ];
  const altFrame = tui(1, COLS, ROWS); // enters the alternate screen and paints one whole frame
  const results: unknown[] = [];
  for (const c of cases) {
    const mirrors = {} as PerEngine<TerminalMirror>;
    for (const e of ENGINES) {
      mirrors[e] = make(e, COLS, ROWS, c.limit);
      await feed(mirrors[e], fill);
      if (c.alt) await parsed(mirrors[e], altFrame);
    }
    const times: PerEngine<number[]> = { xterm: [], ghostty: [] };
    const sizes: PerEngine<number> = { xterm: 0, ghostty: 0 };
    for (let i = -2; i < SNAP_REPS; i++) {
      for (const e of order(Math.max(i, 0))) {
        const t0 = performance.now();
        const s = mirrors[e].snapshot(c.opts) ?? '';
        const t = performance.now() - t0;
        sizes[e] = Buffer.byteLength(s);
        if (i >= 0) times[e].push(t);
      }
    }
    for (const e of ENGINES) mirrors[e].dispose();
    results.push({
      scrollback: c.label,
      xterm: { ms: stats(times.xterm), bytes: sizes.xterm },
      ghostty: { ms: stats(times.ghostty), bytes: sizes.ghostty },
    });
    console.error(`  snapshot ${c.label} done`);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// 3 Memory and 4 cold start: each in a child process

/** The wasm memory behind a GhosttyMirror, by looking at its private fields (no API is added for it); null if not reachable. */
function wasmBytes(m: unknown): number | null {
  let o: unknown = m;
  for (const k of ['term', 'e', 'g', 'memory']) {
    if (typeof o !== 'object' || o === null) return null;
    o = (o as Record<string, unknown>)[k];
  }
  return o instanceof WebAssembly.Memory ? o.buffer.byteLength : null;
}

const mem = () => {
  const u = process.memoryUsage();
  return { rss: u.rss, heapUsed: u.heapUsed, external: u.external, arrayBuffers: u.arrayBuffers };
};
const settle = async () => {
  for (let i = 0; i < 3; i++) {
    gc();
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function childMemory(engine: EngineName, n: number): Promise<void> {
  const fill = chunked(buildLog(0, 2300));
  // One throwaway mirror, so one-time costs (wasm compile, JIT, lazy module state) are not charged to the mirrors.
  const warm = make(engine, COLS, ROWS, REPLAY_SCROLLBACK);
  await feed(warm, fill);
  warm.dispose();
  await settle();
  const before = mem();
  const mirrors: TerminalMirror[] = [];
  for (let i = 0; i < n; i++) {
    const m = make(engine, COLS, ROWS, REPLAY_SCROLLBACK);
    await feed(m, fill);
    mirrors.push(m);
  }
  await settle();
  const after = mem();
  const wasm = mirrors.map(wasmBytes);
  const wasmTotal = wasm.every((w) => w !== null) ? wasm.reduce((a: number, w) => a + (w ?? 0), 0) : null;
  console.log(
    JSON.stringify({
      rss: after.rss - before.rss,
      // arrayBuffers is a subset of external (Node docs), so adding it too would count it twice
      tracked: after.heapUsed + after.external - (before.heapUsed + before.external),
      heapUsed: after.heapUsed - before.heapUsed,
      external: after.external - before.external,
      arrayBuffers: after.arrayBuffers - before.arrayBuffers,
      wasmBytes: wasmTotal,
    }),
  );
}

async function childCold(engine: EngineName): Promise<void> {
  const t0 = performance.now();
  const m = make(engine, COLS, ROWS, REPLAY_SCROLLBACK);
  const t1 = performance.now();
  await parsed(m, buildLog(0, 20));
  const t2 = performance.now();
  m.snapshot();
  const t3 = performance.now();
  m.dispose();
  const t4 = performance.now();
  const m2 = make(engine, COLS, ROWS, REPLAY_SCROLLBACK);
  const t5 = performance.now();
  m2.dispose();
  console.log(
    JSON.stringify({ firstCreate: t1 - t0, firstWrite: t2 - t1, firstSnapshot: t3 - t2, firstDispose: t4 - t3, secondCreate: t5 - t4 }),
  );
}

function runChild(mode: string, engine: EngineName, extra: string[] = []): Record<string, number | null> {
  const r = spawnSync(
    process.execPath,
    [...process.execArgv, '--expose-gc', process.argv[1], '--child', mode, '--engine', engine, ...extra],
    {
      encoding: 'utf8',
      maxBuffer: 16 * MIB,
    },
  );
  if (r.status !== 0) throw new Error(`child ${mode} ${engine} failed: ${r.stderr || r.error?.message}`);
  const line = r.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as Record<string, number | null>;
}

function memory(): unknown[] {
  const results: unknown[] = [];
  for (const n of [1, 20]) {
    const runs: PerEngine<Record<string, number | null>[]> = { xterm: [], ghostty: [] };
    for (let i = 0; i < MEM_REPEATS; i++) for (const e of order(i)) runs[e].push(runChild('mem', e, ['--n', String(n)]));
    const row: Record<string, unknown> = { mirrors: n };
    for (const e of ENGINES) {
      const med = (k: string) => median(runs[e].map((r) => r[k] ?? 0));
      const wasm = runs[e].map((r) => r.wasmBytes);
      row[e] = {
        rssMiB: r2(med('rss') / MIB),
        trackedMiB: r2(med('tracked') / MIB),
        heapUsedMiB: r2(med('heapUsed') / MIB),
        externalMiB: r2(med('external') / MIB),
        arrayBuffersMiB: r2(med('arrayBuffers') / MIB),
        rssPerMirrorMiB: r2(med('rss') / MIB / n),
        trackedPerMirrorMiB: r2(med('tracked') / MIB / n),
        wasmMemoryMiB: e === 'ghostty' && wasm.every((w) => w !== null) ? r2(median(wasm as number[]) / MIB) : 'n/a',
        repeats: runs[e].length,
      };
    }
    results.push(row);
    console.error(`  memory x${n} done`);
  }
  return results;
}

async function construction(): Promise<unknown> {
  const times: PerEngine<number[]> = { xterm: [], ghostty: [] };
  for (let i = -5; i < CONSTRUCT_REPS; i++) {
    for (const e of order(Math.max(i, 0))) {
      const t0 = performance.now();
      make(e, COLS, ROWS, REPLAY_SCROLLBACK).dispose();
      const t = performance.now() - t0;
      if (i >= 0) times[e].push(t);
    }
  }
  const cold: PerEngine<Record<string, number>[]> = { xterm: [], ghostty: [] };
  for (let i = 0; i < COLD_REPEATS; i++) {
    for (const e of order(i)) cold[e].push(runChild('cold', e) as Record<string, number>);
  }
  const coldMed = (e: EngineName) => {
    const out: Record<string, number> = {};
    for (const k of Object.keys(cold[e][0])) out[k] = r2(median(cold[e].map((r) => r[k])));
    return out;
  };
  return {
    createDisposeMs: { xterm: stats(times.xterm), ghostty: stats(times.ghostty) },
    coldChildMs: { xterm: coldMed('xterm'), ghostty: coldMed('ghostty'), repeats: COLD_REPEATS },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// 5 Event-loop blocking

async function stalls(): Promise<unknown> {
  const chunks = chunked(buildLog(BYTES));
  const runs: PerEngine<Record<string, number>[]> = { xterm: [], ghostty: [] };
  for (let i = 0; i < STALL_RUNS; i++) {
    for (const e of order(i)) {
      gc();
      const m = make(e, COLS, ROWS, REPLAY_SCROLLBACK);
      const h = monitorEventLoopDelay({ resolution: 1 });
      let maxSync = 0;
      let maxDone = 0;
      h.enable();
      for (const c of chunks) {
        const t0 = performance.now();
        const done = parsed(m, c);
        const sync = performance.now() - t0;
        await done;
        maxSync = Math.max(maxSync, sync);
        maxDone = Math.max(maxDone, performance.now() - t0);
        // Output reaches the host in separate events, not one microtask chain: let the loop turn between chunks.
        await new Promise<void>((r) => setImmediate(r));
      }
      h.disable();
      m.dispose();
      runs[e].push({
        maxSyncWriteMs: maxSync,
        maxWriteToDoneMs: maxDone,
        loopDelayMaxMs: h.max / 1e6,
        loopDelayP99Ms: h.percentile(99) / 1e6,
      });
    }
  }
  const out: Record<string, unknown> = { chunks: chunks.length, runs: STALL_RUNS };
  for (const e of ENGINES) {
    const sum: Record<string, number> = {};
    for (const k of Object.keys(runs[e][0])) {
      sum[`${k}Median`] = r2(median(runs[e].map((r) => r[k])));
      sum[`${k}Worst`] = r2(Math.max(...runs[e].map((r) => r[k])));
    }
    out[e] = sum;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// 6 Fidelity

type Headless = InstanceType<typeof Terminal>;
function freshTerminal(cols: number, rows: number): Headless {
  const t = new Terminal({ cols, rows, scrollback: REPLAY_SCROLLBACK, allowProposedApi: true });
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  return t;
}
const termWrite = (t: Headless, s: string) => new Promise<void>((res) => t.write(s, res));
function termScreen(t: Headless): string[] {
  const buf = t.buffer.active;
  const lines: string[] = [];
  for (let y = buf.viewportY; y < buf.viewportY + t.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  return lines;
}
/** 120 characters of `s`, starting a little before the first place it differs from `other`. */
function cut(s: string, other: string): string {
  let i = 0;
  while (i < s.length && s[i] === other[i]) i++;
  const from = Math.max(0, i - 20);
  const t = s.slice(from, from + 120);
  return `${from > 0 ? '...' : ''}${t.length < s.length - from ? t.slice(0, 117) + '...' : t}`;
}

function diffRows(a: string[], b: string[]): { count: number; examples: { row: number; a: string; b: string }[] } {
  const examples: { row: number; a: string; b: string }[] = [];
  let count = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      count++;
      if (examples.length < 3) examples.push({ row: i, a: cut(a[i] ?? '', b[i] ?? ''), b: cut(b[i] ?? '', a[i] ?? '') });
    }
  }
  return { count, examples };
}

async function fidelity(): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const c of THROUGHPUT_CASES) {
    const chunks = chunked(corpus(c.corpus, FIDELITY_BYTES, c.cols, c.rows));
    const ref = freshTerminal(c.cols, c.rows);
    for (const ch of chunks) await termWrite(ref, ch);
    const refScreen = termScreen(ref);
    const refCursor = { x: ref.buffer.active.cursorX, y: ref.buffer.active.cursorY };
    ref.dispose();
    const row: Record<string, unknown> = { corpus: c.corpus, grid: `${c.cols}x${c.rows}`, rows: c.rows };
    const own = {} as PerEngine<string[]>;
    const replayedScreens = {} as PerEngine<string[]>;
    for (const e of ENGINES) {
      const m = make(e, c.cols, c.rows, REPLAY_SCROLLBACK);
      await feed(m, chunks);
      own[e] = m.screenText().split('\n');
      const snap = m.snapshot() ?? '';
      m.dispose();
      const fresh = freshTerminal(c.cols, c.rows);
      await termWrite(fresh, snap);
      const replayed = termScreen(fresh);
      replayedScreens[e] = replayed;
      const cursor = { x: fresh.buffer.active.cursorX, y: fresh.buffer.active.cursorY };
      fresh.dispose();
      const vsOwn = diffRows(replayed, own[e]);
      const vsRaw = diffRows(replayed, refScreen);
      row[e] = {
        mismatchedRowsVsOwnScreen: vsOwn.count,
        mismatchedRowsVsRawReplay: vsRaw.count,
        cursorMatchesRawReplay: cursor.x === refCursor.x && cursor.y === refCursor.y,
        cursor,
        rawReplayCursor: refCursor,
        examples: vsOwn.examples.map((x) => ({ row: x.row, replayed: x.a, own: x.b })),
      };
    }
    const cross = diffRows(own.xterm, own.ghostty);
    row.xtermVsGhosttyScreenRows = {
      differingRows: cross.count,
      examples: cross.examples.map((x) => ({ row: x.row, xterm: x.a, ghostty: x.b })),
    };
    const crossReplayed = diffRows(replayedScreens.xterm, replayedScreens.ghostty);
    row.xtermVsGhosttyReplayedRows = {
      differingRows: crossReplayed.count,
      examples: crossReplayed.examples.map((x) => ({ row: x.row, xterm: x.a, ghostty: x.b })),
    };
    results.push(row);
    console.error(`  fidelity ${c.corpus} ${c.cols}x${c.rows} done`);
  }
  return results;
}

// ---------------------------------------------------------------------------------------------------------------
// Main

type Stat = { median: number; min: number; max: number };
function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ')).join('\n');
}

function print(res: Record<string, unknown>): void {
  const t = res.throughput as Record<string, any>[];
  console.log('\nParse throughput, MiB/s: awaited per chunk (median [min-max]) and pipelined (median)');
  console.log(
    table([
      ['corpus', 'grid', 'xterm', 'xterm pipelined', 'ghostty', 'ghostty/xterm', 'ghostty/xterm piped'],
      ...t.map((r) => {
        const x = r.xterm.mibPerS as Stat;
        const g = r.ghostty.mibPerS as Stat;
        return [
          r.corpus,
          r.grid,
          `${x.median} [${x.min}-${x.max}]`,
          String(r.xterm.pipelinedMibPerS.median),
          `${g.median} [${g.min}-${g.max}]`,
          `${r2(g.median / x.median)}x`,
          `${r2(r.ghostty.pipelinedMibPerS.median / r.xterm.pipelinedMibPerS.median)}x`,
        ];
      }),
    ]),
  );
  const s = res.snapshot as Record<string, any>[];
  console.log('\nSnapshot at 200x50: ms (median) and bytes');
  console.log(
    table([
      ['scrollback', 'xterm ms', 'ghostty ms', 'xterm KiB', 'ghostty KiB'],
      ...s.map((r) => [
        String(r.scrollback),
        String(r.xterm.ms.median),
        String(r.ghostty.ms.median),
        String(r2(r.xterm.bytes / 1024)),
        String(r2(r.ghostty.bytes / 1024)),
      ]),
    ]),
  );
  const m = res.memory as Record<string, any>[];
  console.log('\nMemory (2000 lines each, 200x50, after gc): MiB');
  console.log(
    table([
      ['mirrors', 'xterm rss', 'ghostty rss', 'xterm heap+ext', 'ghostty heap+ext', 'ghostty wasm'],
      ...m.map((r) => [
        String(r.mirrors),
        String(r.xterm.rssMiB),
        String(r.ghostty.rssMiB),
        String(r.xterm.trackedMiB),
        String(r.ghostty.trackedMiB),
        String(r.ghostty.wasmMemoryMiB),
      ]),
    ]),
  );
  const c = res.construction as Record<string, any>;
  console.log('\nConstruction (ms)');
  console.log(
    table([
      ['', 'xterm', 'ghostty'],
      ['create+dispose, median', String(c.createDisposeMs.xterm.median), String(c.createDisposeMs.ghostty.median)],
      ['cold first create', String(c.coldChildMs.xterm.firstCreate), String(c.coldChildMs.ghostty.firstCreate)],
      ['cold first write', String(c.coldChildMs.xterm.firstWrite), String(c.coldChildMs.ghostty.firstWrite)],
    ]),
  );
  const l = res.eventLoop as Record<string, any>;
  console.log(`\nEvent-loop blocking feeding a build log (${l.chunks} chunks), ms: median / worst of ${l.runs}`);
  console.log(
    table([
      ['', 'xterm', 'ghostty'],
      ...(
        [
          ['longest sync write()', 'maxSyncWriteMs'],
          ['longest write -> done', 'maxWriteToDoneMs'],
          ['loop delay max', 'loopDelayMaxMs'],
          ['loop delay p99', 'loopDelayP99Ms'],
        ] as const
      ).map(([label, k]) => [label, ...ENGINES.map((e) => `${l[e][`${k}Median`]} / ${l[e][`${k}Worst`]}`)]),
    ]),
  );
  const f = res.fidelity as Record<string, any>[];
  console.log('\nReplay fidelity (rows of the screen that differ; cursor = same as a fresh terminal fed the raw corpus)');
  console.log(
    table([
      ['corpus', 'grid', 'xterm rows', 'ghostty rows', 'xterm cursor', 'ghostty cursor', 'xterm vs ghostty (own / replayed)'],
      ...f.map((r) => [
        r.corpus,
        r.grid,
        `${r.xterm.mismatchedRowsVsOwnScreen}/${r.rows}`,
        `${r.ghostty.mismatchedRowsVsOwnScreen}/${r.rows}`,
        r.xterm.cursorMatchesRawReplay ? 'ok' : 'DIFF',
        r.ghostty.cursorMatchesRawReplay ? 'ok' : 'DIFF',
        `${r.xtermVsGhosttyScreenRows.differingRows} / ${r.xtermVsGhosttyReplayedRows.differingRows} of ${r.rows}`,
      ]),
    ]),
  );
}

async function main(): Promise<void> {
  const childMode = arg('child', '');
  if (childMode) {
    const engine = arg('engine', 'xterm') as EngineName;
    if (childMode === 'mem') await childMemory(engine, Number(arg('n', '1')));
    else await childCold(engine);
    return;
  }

  const started = Date.now();
  console.error(`terminal-engines${QUICK ? ' (quick)' : ''}: ${BYTES / MIB} MiB corpora, ${RUNS} runs`);
  const machine = {
    node: process.version,
    platform: `${process.platform} ${os.release()} ${process.arch}`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cpus: os.cpus().length,
    totalMemGiB: r2(os.totalmem() / 1024 ** 3),
    date: new Date().toISOString(),
  };
  // Construction first: before this process has grown, and its cold numbers come from children anyway.
  const construct = await construction();
  const res: Record<string, unknown> = {
    machine,
    config: { quick: QUICK, corpusBytes: BYTES, runs: RUNS, chunkChars: CHUNK, grid: `${COLS}x${ROWS}`, scrollback: REPLAY_SCROLLBACK },
    throughput: await throughput(),
    snapshot: await snapshots(),
    memory: memory(),
    construction: construct,
    eventLoop: await stalls(),
    fidelity: await fidelity(),
    caveats: [
      'Both engines are timed through the same TerminalMirror interface, but their write paths differ by design: ScreenMirror queues writes and xterm parses them in timer slices (its done callback fires later), GhosttyMirror parses inside write() and calls done in a microtask. Throughput therefore includes xterm.js scheduling and the per-chunk promise round trip; it is what the host sees, not a bare parser benchmark.',
      'Awaiting every chunk (the spec) charges xterm.js a timer hop per 16 KiB chunk (its parse runs from setTimeout), which the host does not pay because PTY reads do not wait for a parse; the pipelined figures write all chunks first and await the last, and are the fairer picture of the host. GhosttyMirror is the same either way.',
      'Throughput chunks are 16384 UTF-16 characters (never splitting a surrogate pair), not 16 KiB of UTF-8; MiB counts UTF-8 bytes of the corpus. Escape sequences can be split across chunks, identically for both engines.',
      'ScreenMirror also tracks modes with parser hooks and GhosttyMirror reads them back at snapshot time: that is part of each engine as shipped and is not separated out.',
      'GhosttyMirror is given twice the scrollback limit internally (libghostty drops whole pages), so at equal nominal scrollback it holds more lines in memory than xterm does.',
      'All 5-run medians come from one machine and one Node build, in one process for time measurements; the order of engines alternates per run, but V8 JIT state and heap growth in the shared process cannot be fully isolated (memory and cold start are measured in children for that reason).',
      'The tracked (heapUsed + external) figure leaves out libghostty-vt wasm memory, which Node does not count in either: compare RSS, and see the wasm column. Memory children warm one throwaway mirror first so wasm compile and JIT one-offs are excluded from the per-mirror delta (they are in the cold-start numbers). Each child loads both engines modules, so the baseline holds both. arrayBuffers is a subset of external, so tracked = heapUsed + external, not the sum of all three.',
      'The ghostty wasm memory size is read from private fields (term.e.g.memory) of GhosttyMirror without adding API; it is the instance memory size (grown, never shrunk), not live bytes.',
      'A ghostty row count above 0 in the fidelity table compares the replayed screen with GhosttyMirror.screenText(), not with another terminal: the replayed screens of the two engines are compared separately (replayed) and are what the client draws. screenText() differs from xterm in trailing spaces (ghostty trims written spaces) and in how wide or wrapped Unicode rows are split; that is a diagnostics-text difference, not a replay difference.',
      'Fidelity replays into @xterm/headless with Unicode 11, standing in for the browser client (not a renderer: wrapped-line and wide-cell layout are compared as text, colours and attributes are not).',
      'Event-loop numbers yield to the loop with setImmediate between chunks, as separate PTY reads would; real PTY output is bursty and the host also does socket work, so absolute values are a lower bound.',
    ],
    elapsedSeconds: r2((Date.now() - started) / 1000),
  };
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, 'terminal-engines.json');
  fs.writeFileSync(file, JSON.stringify(res, null, 2));
  print(res);
  console.log(`\nwrote ${file} (${res.elapsedSeconds} s)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
