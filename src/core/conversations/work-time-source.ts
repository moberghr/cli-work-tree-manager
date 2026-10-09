import fs from 'node:fs';
import { agentOf } from '../agents/index.js';
import type { ConversationEntry } from '../agents/types.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { mergeSteps, workedBetween, workedByDay, workSteps, type WorkStep } from './work-time.js';
import type { WorkTimeWire } from '../api-types.js';

/**
 * A session's Claude working time (work-time.ts) from all its transcripts.
 * Each file is read once, then only what was appended since — a transcript
 * only grows; one that shrank, changed without growing, or whose first bytes
 * differ was rewritten, and is read again — a megabyte at a time with a pause
 * between, so a long conversation doesn't hold up the server. Kept in memory
 * (two numbers per step), at most MAX_FILES files, the least recently asked
 * about going first: cheap to rebuild.
 */

const CHUNK = 1 << 20;
const DAYS_SHOWN = 14;
const MAX_FILES = 400;
/** How much of a file's start identifies it (a rewrite starts differently). */
const HEAD_BYTES = 256;

interface FileState {
  /** Bytes read up to the last complete line. */
  offset: number;
  mtimeMs: number;
  lastMs: number | null;
  steps: WorkStep[];
  prompts: number;
  firstMs: number | null;
  /** Its first bytes, as read. */
  head: string;
}

const files = new Map<string, FileState>();

async function readHead(fh: fs.promises.FileHandle, size: number): Promise<string> {
  const buf = Buffer.alloc(Math.min(HEAD_BYTES, size));
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  return buf.subarray(0, bytesRead).toString('base64');
}

/** Read what was appended to `file` since `st` (or all of it), line by line. */
async function readOn(
  file: string,
  size: number,
  mtimeMs: number,
  st: FileState | undefined,
  toEntries: (lines: readonly unknown[]) => ConversationEntry[],
): Promise<FileState> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const head = await readHead(fh, size);
    // Appended to, or rewritten? An append grows it and leaves its start as it was.
    const appended =
      !!st &&
      size >= st.offset &&
      !(size === st.offset && mtimeMs !== st.mtimeMs) &&
      head.startsWith(st.head.slice(0, head.length)) &&
      st.head.startsWith(head.slice(0, st.head.length));
    const state: FileState = appended
      ? { ...st!, steps: [...st!.steps], mtimeMs, head }
      : { offset: 0, mtimeMs, lastMs: null, steps: [], prompts: 0, firstMs: null, head };
    // Bytes read past the last newline (kept as bytes: a character can be cut in two).
    let carry = Buffer.alloc(0);
    while (state.offset + carry.length < size) {
      const at = state.offset + carry.length;
      const buf = Buffer.alloc(Math.min(CHUNK, size - at));
      const { bytesRead } = await fh.read(buf, 0, buf.length, at);
      if (bytesRead === 0) break;
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      const cut = data.lastIndexOf(0x0a);
      // An incomplete last line stays for the next read (the file is being written).
      if (cut === -1) {
        carry = data;
        continue;
      }
      const whole = data.subarray(0, cut).toString('utf8');
      carry = data.subarray(cut + 1);
      state.offset += cut + 1;
      const lines: unknown[] = [];
      for (const line of whole.split('\n')) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line));
        } catch {
          /* a torn or foreign line: skip it */
        }
      }
      const entries = toEntries(lines);
      const r = workSteps(entries, state.lastMs);
      state.steps.push(...r.steps);
      state.lastMs = r.lastMs;
      if (state.firstMs === null) {
        const first = entries.find((e) => Number.isFinite(Date.parse(e.at)));
        if (first) state.firstMs = Date.parse(first.at);
      }
      state.prompts += entries.filter((e) => e.role === 'you' && !e.sidechain).length;
      // Let the server breathe between megabytes.
      await new Promise((r2) => setImmediate(r2));
    }
    return state;
  } finally {
    await fh.close();
  }
}

/** How long the session's Claude worked: in all, per day (the last two weeks), and the prompts it was given. */
/** `days`: how far back `byDay` reaches (the Time tab's catch-up asks for its own). */
export async function sessionWorkTime(s: WorktreeSession, now = Date.now(), days = DAYS_SHOWN): Promise<WorkTimeWire> {
  const steps: WorkStep[] = [];
  let prompts = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const conv = agentOf(s).conversation;
  for (const t of conv?.files(s) ?? []) {
    let st = files.get(t.file);
    if (!st || st.offset !== t.size || st.mtimeMs !== t.mtimeMs) {
      try {
        st = await readOn(t.file, t.size, t.mtimeMs, st, conv!.entries);
      } catch {
        continue; // gone or unreadable: count what can be read
      }
    }
    // Most recently asked about last; the oldest go past MAX_FILES.
    files.delete(t.file);
    files.set(t.file, st);
    while (files.size > MAX_FILES) files.delete(files.keys().next().value!);
    steps.push(...st.steps);
    prompts += st.prompts;
    if (st.firstMs !== null) firstMs = firstMs === null ? st.firstMs : Math.min(firstMs, st.firstMs);
    if (st.lastMs !== null) lastMs = lastMs === null ? st.lastMs : Math.max(lastMs, st.lastMs);
  }
  const since = now - days * 24 * 3600_000;
  // Two transcripts working at the same time count that time once.
  const merged = mergeSteps(steps);
  return {
    workedMs: workedBetween(merged),
    prompts,
    byDay: workedByDay(merged, since),
    firstAt: firstMs === null ? null : new Date(firstMs).toISOString(),
    lastAt: lastMs === null ? null : new Date(lastMs).toISOString(),
  };
}

/** Forget what was read (tests). */
export function resetWorkTimeCache(): void {
  files.clear();
}
