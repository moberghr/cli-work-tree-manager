import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readTranscriptSince, readTranscriptTail } from '../../src/core/transcript.js';

const T0 = Date.parse('2026-09-29T08:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
/** ~120 bytes per line, so chunk sizes below are a handful of lines. */
const line = (min: number, i: number) =>
  JSON.stringify({ type: 'user', timestamp: at(min), uuid: `u${i}`, message: { content: `prompt ${i} ${'x'.repeat(60)}` } });

let dir: string;
let file: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  file = path.join(dir, 't.jsonl');
  // 40 entries, one a minute, from an hour before T0 to 20 minutes before it.
  fs.writeFileSync(file, Array.from({ length: 40 }, (_, i) => line(i - 60, i)).join('\n') + '\n');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readTranscriptSince', () => {
  it('reads back from the end, growing, until it passes the window start', async () => {
    // Since 30 min before T0: entries 30..39 are in; the read must reach entry 29.
    const w = await readTranscriptSince(file, T0 - 30 * 60_000, { chunkBytes: 300 });
    expect(w.partial).toBe(false);
    const ids = w.entries.map((e) => e.uuid);
    expect(ids.slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => `u${30 + i}`));
    expect(ids).toContain('u29'); // the first entry older than the window proves coverage
    expect(ids.length).toBeLessThan(40); // …and it did not read the whole file
  });

  it('reads the whole file when everything is in the window', async () => {
    const w = await readTranscriptSince(file, T0 - 24 * 3_600_000, { chunkBytes: 300 });
    expect(w.partial).toBe(false);
    expect(w.entries).toHaveLength(40);
  });

  it('stops at the byte cap and says the result is partial', async () => {
    const w = await readTranscriptSince(file, T0 - 24 * 3_600_000, { chunkBytes: 300, maxBytes: 1000 });
    expect(w.partial).toBe(true);
    expect(w.entries.length).toBeGreaterThan(0);
    expect(w.entries.length).toBeLessThan(40);
  });

  it('is empty, not partial, for a missing file', async () => {
    expect(await readTranscriptSince(path.join(dir, 'nope.jsonl'), T0)).toEqual({ entries: [], partial: false });
  });
});

describe('readTranscriptTail', () => {
  it('skips the partial first line of a tail', () => {
    const entries = readTranscriptTail(file, 500);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(typeof e.uuid).toBe('string');
  });
});
