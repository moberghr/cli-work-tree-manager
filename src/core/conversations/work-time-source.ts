import fs from 'node:fs';
import { agentOf } from '../agents/index.js';
import type { ConversationEntry } from '../agents/types.js';
import type { WorktreeSession } from '../sessions/session-types.js';
import { mergeSteps, workedBetween, workedByDay, workSteps, type WorkStep } from './work-time.js';
import { dayKey } from './work-time-view.js';
import type { TokenTotals, WorkTimeWire } from '../api-types.js';

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
  /** Tokens by local day and model (input = prompt less its cached part). */
  tokens: Record<string, Record<string, TokenTotals>>;
  /** The last agent message counted: its other lines (one per content block) repeat its usage. */
  lastMessage: string | null;
}

/** An agent message's usage into `tokens`, once per message id (`lastMessage`: lines of one message are adjacent). */
function countTokens(state: FileState, entries: readonly ConversationEntry[]): void {
  for (const e of entries) {
    if (e.role !== 'agent' || !e.usage) continue;
    if (e.message) {
      if (e.message === state.lastMessage) continue;
      state.lastMessage = e.message;
    }
    const ms = Date.parse(e.at);
    if (!Number.isFinite(ms)) continue;
    const cached = e.usage.cached ?? 0;
    const byModel = (state.tokens[dayKey(ms)] ??= {});
    const t = (byModel[e.model ?? 'unknown'] ??= { input: 0, cached: 0, output: 0 });
    t.input += Math.max(0, e.usage.prompt - cached);
    t.cached += cached;
    t.output += e.usage.reply;
  }
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
      ? { ...st!, steps: [...st!.steps], tokens: structuredClone(st!.tokens), mtimeMs, head }
      : { offset: 0, mtimeMs, lastMs: null, steps: [], prompts: 0, firstMs: null, head, tokens: {}, lastMessage: null };
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
      countTokens(state, entries);
      // Let the server breathe between megabytes.
      await new Promise((r2) => setImmediate(r2));
    }
    return state;
  } finally {
    await fh.close();
  }
}

/**
 * The session's files (`usage`: the ones whose tokens count, subagents' included — else its conversations), brought
 * up to date (read once, then what was appended). One last written before `minMtimeMs` is skipped.
 */
async function upToDate(s: WorktreeSession, o: { usage?: boolean; minMtimeMs?: number } = {}): Promise<FileState[]> {
  const out: FileState[] = [];
  const conv = agentOf(s).conversation;
  const list = o.usage && conv?.usageFiles ? conv.usageFiles(s) : (conv?.files(s) ?? []);
  for (const t of list) {
    if (o.minMtimeMs !== undefined && t.mtimeMs < o.minMtimeMs) continue;
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
    out.push(st);
  }
  return out;
}

/** Local midnight starting `day` (`YYYY-MM-DD`); undefined for anything else. */
function dayStartMs(day: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined;
}

/**
 * The session's tokens by local day (`YYYY-MM-DD`, from `sinceDay` on) and model, its subagents' included (the
 * agent's `usageFiles`). A file last written before `sinceDay` began can't hold any of them, and isn't read.
 */
export async function sessionTokens(s: WorktreeSession, sinceDay: string): Promise<Record<string, Record<string, TokenTotals>>> {
  const out: Record<string, Record<string, TokenTotals>> = {};
  for (const st of await upToDate(s, { usage: true, minMtimeMs: dayStartMs(sinceDay) })) {
    for (const [day, byModel] of Object.entries(st.tokens)) {
      if (day < sinceDay) continue;
      for (const [model, t] of Object.entries(byModel)) {
        const sum = ((out[day] ??= {})[model] ??= { input: 0, cached: 0, output: 0 });
        sum.input += t.input;
        sum.cached += t.cached;
        sum.output += t.output;
      }
    }
  }
  return out;
}

/**
 * How long the session's Claude worked: in all, per day (the last `days`, two
 * weeks unless asked — the Time tab's catch-up asks for its own), and the
 * prompts it was given.
 */
export async function sessionWorkTime(s: WorktreeSession, now = Date.now(), days = DAYS_SHOWN): Promise<WorkTimeWire> {
  const steps: WorkStep[] = [];
  let prompts = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  for (const st of await upToDate(s)) {
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
