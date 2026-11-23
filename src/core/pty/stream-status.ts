/**
 * What an agent says about itself in its own output (terminal-rendering.md, "Status from the stream"). Two in-band
 * signals, each handed here whole by the mirror's parser (screen-mirror.ts):
 *
 * - **OSC 9 ; 4 ; state ; percent** — ConEmu's progress, also Windows Terminal's taskbar: 0 remove, 1 a percent,
 *   2 error, 3 indeterminate, 4 paused. Parsed as `@xterm/addon-progress` parses it.
 * - **OSC 7501 ; key=value:…** — the Program Status Protocol (rev 0.4): `state` idle, working, blocked, done, error or
 *   clear, with `id`, `kind`, `progress`, `app`, `title`, `msg`. Codex, opencode and Claude Code (when the terminal
 *   answers its probe) send it. Parsed as `@xterm/addon-program-status` parses it.
 *
 * Bounded: at most `MAX_RECORDS` records, each from a report of at most `MAX_PAYLOAD` bytes. Pure but for the clock.
 */

export const PROGRAM_STATES = ['idle', 'working', 'blocked', 'done', 'error'] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];
export const PROGRAM_KINDS = ['permission', 'question', 'auth'] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

/** One OSC 7501 record (a report replaces its record whole). `id` '' is the root. */
export interface ProgramRecord {
  id: string;
  state: ProgramState;
  /** With `blocked` only. */
  kind?: ProgramKind;
  /** 0..100, with `working` or `blocked` only; absent: no percentage. */
  progress?: number;
  app?: string;
  /** `msg`, decoded: one line saying what it is doing or waiting for. */
  message?: string;
}

/** OSC 9;4 states, by ConEmu's numbers. */
export const PROGRESS_REMOVE = 0;
export const PROGRESS_SET = 1;
export const PROGRESS_ERROR = 2;
export const PROGRESS_INDETERMINATE = 3;
export const PROGRESS_PAUSED = 4;

export interface ProgressReport {
  state: 0 | 1 | 2 | 3 | 4;
  /** 0..100. */
  percent: number;
}

/** What the stream says now, as the PTY host reports it (`PtyInfo.signal`). Each part absent when nothing is said. */
export interface StreamSignal {
  /** OSC 7501: the record that says the most (`summarize`), and since when it has said that state (ISO). */
  program?: ProgramRecord & { since: string };
  /** OSC 9;4, while a bar is up (state 1..4), and since when it has been in that state (ISO). Never once an OSC 7501 report came. */
  progress?: ProgressReport & { since: string };
}

/** The spec's floor for records a terminal keeps (xterm.js keeps 256); the least recently updated goes first. */
export const MAX_RECORDS = 64;
/** The whole sequence may take 4096 bytes; `ESC ] 7501 ;` and `ESC \` take 9 of them. */
export const MAX_PAYLOAD = 4087;
const MAX_KEY = 16;
const MAX_APP = 32;
const MAX_ID = 128;
const TEXT_LIMITS = { title: { encoded: 256, decoded: 192 }, msg: { encoded: 2732, decoded: 2048 } } as const;

const VALUE_REX = /^[A-Za-z0-9_.,+/=-]*$/;
const APP_REX = /^[A-Za-z0-9_.+-]{1,32}$/;
const ID_REX = /^[A-Za-z0-9_.+-]{1,32}(?:\/[A-Za-z0-9_.+-]{1,32}){0,7}$/;
const PROGRESS_REX = /^0*([0-9]{1,3})$/;
const BASE64_REX = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTROL_REX = /\p{Control}/u;
const KNOWN_KEYS = new Set(['state', 'id', 'kind', 'progress', 'app', 'title', 'msg']);

/** Only decimal digits; '' is 0 and anything else -1 (addon-progress's `toInt`). */
function toInt(s: string): number {
  return /^[0-9]*$/.test(s) ? Number(s || '0') : -1;
}

/**
 * The data of an OSC 9 sequence, read as ConEmu progress (`4;state;percent`), as `@xterm/addon-progress` reads it: not
 * `4;…` — another OSC 9 (a notification) — or more than three fields is nothing; a missing percent is 0; a percent over
 * 100 is 100; a state past 4 or a percent that isn't digits (where one counts) is nothing. Error and paused keep the
 * last percent when given 0, indeterminate always keeps it. Undefined: ignore it.
 */
export function parseProgress(data: string, lastPercent: number): ProgressReport | undefined {
  if (!data.startsWith('4;')) return undefined;
  const parts = data.split(';');
  if (parts.length > 3) return undefined;
  const state = toInt(parts[1]);
  const pr = toInt(parts[2] ?? '');
  const clamp = (n: number) => Math.min(Math.max(n, 0), 100);
  switch (state) {
    case PROGRESS_REMOVE:
      return { state, percent: 0 };
    case PROGRESS_SET:
      return pr < 0 ? undefined : { state, percent: clamp(pr) };
    case PROGRESS_ERROR:
    case PROGRESS_PAUSED:
      return pr < 0 ? undefined : { state, percent: clamp(pr || lastPercent) };
    case PROGRESS_INDETERMINATE:
      return { state, percent: clamp(lastPercent) };
    default:
      return undefined;
  }
}

const utf8Length = (s: string): number => Buffer.byteLength(s, 'utf8');
/** ASCII whitespace off both ends (String.trim also takes other Unicode spaces). */
const trim = (s: string): string => s.replace(/^[ \t\n\v\f\r]+/, '').replace(/[ \t\n\v\f\r]+$/, '');

/** A `title` / `msg` value: canonical base64 (padding optional) of UTF-8 text with no control characters, within `max` bytes. */
function decodeText(value: string, max: number): string | undefined {
  if (value.length % 4 === 1 || (value.endsWith('=') && value.length % 4 !== 0) || !BASE64_REX.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max) return undefined;
  // Only the canonical encoding: the bits past the last byte are zero (re-encoding gives the same characters).
  if (bytes.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) return undefined;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
  return CONTROL_REX.test(text) ? undefined : text;
}

/**
 * The data of an OSC 7501 report, as `@xterm/addon-program-status` reads it: `:`-separated `key=value` pairs, the last
 * of a key winning; a pair without `=` or with an unknown key is skipped, a value outside the spec's characters is
 * skipped; the report is discarded for a payload over 4087 bytes, an unknown key over 16, a malformed `id`, an `app`
 * over 32 or a `title` / `msg` over its limit or that doesn't decode; a missing or unknown `state` is nothing. `?` (the
 * probe) is nothing here: the host doesn't answer it (terminal-rendering.md). Undefined: ignore it.
 */
export function parseProgramStatus(data: string): ProgramRecord | { state: 'clear'; id: string } | undefined {
  if (data.length > MAX_PAYLOAD || utf8Length(data) > MAX_PAYLOAD) return undefined;
  const v: { state?: string; id?: string; kind?: string; progress?: string; app?: string; msg?: string } = {};
  for (const pair of data.split(':')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = trim(pair.slice(0, eq));
    if (!KNOWN_KEYS.has(key)) {
      if (utf8Length(key) > MAX_KEY) return undefined;
      continue;
    }
    const value = trim(pair.slice(eq + 1));
    const readable = VALUE_REX.test(value);
    if (key === 'state' || key === 'kind' || key === 'progress') {
      if (readable) v[key] = value;
    } else if (key === 'id') {
      if (value.length > MAX_ID || !ID_REX.test(value)) return undefined;
      v.id = value;
    } else if (key === 'app') {
      if ((readable ? value.length : utf8Length(value)) > MAX_APP) return undefined;
      if (readable) v.app = value;
    } else {
      const limits = TEXT_LIMITS[key as 'title' | 'msg'];
      if ((readable ? value.length : utf8Length(value)) > limits.encoded) return undefined;
      if (!readable) continue;
      const text = decodeText(value, limits.decoded);
      if (text === undefined) return undefined;
      if (key === 'msg') v.msg = text;
    }
  }
  const id = v.id ?? '';
  if (v.state === 'clear') return { state: 'clear', id };
  const state = PROGRAM_STATES.find((s) => s === v.state);
  if (!state) return undefined;
  const record: ProgramRecord = { id, state };
  const kind = PROGRAM_KINDS.find((k) => k === v.kind);
  if (state === 'blocked' && kind) record.kind = kind;
  if ((state === 'working' || state === 'blocked') && v.progress !== undefined) {
    const digits = PROGRESS_REX.exec(v.progress)?.[1];
    if (digits !== undefined && Number(digits) <= 100) record.progress = Number(digits);
  }
  if (v.app !== undefined && APP_REX.test(v.app)) record.app = v.app;
  if (v.msg !== undefined) record.message = v.msg;
  return record;
}

/** The record that says the most: the latest blocked one, else the latest working one, else the root, else the latest. */
export function summarize<T extends ProgramRecord>(records: readonly T[]): T | undefined {
  const latest = (state: ProgramState) => [...records].reverse().find((r) => r.state === state);
  return latest('blocked') ?? latest('working') ?? records.find((r) => r.id === '') ?? records.at(-1);
}

type Stamped<T> = T & { sinceMs: number };

/**
 * One terminal's signals, fed by its mirror's parser: the OSC 7501 records (one per id, at most `MAX_RECORDS`) and the
 * OSC 9;4 bar. A full reset (RIS) forgets both, as `@xterm/addon-program-status` does for its records; the 9;4 bar is
 * forgotten too, since an agent that resets its terminal starts over. A soft reset and the screens change nothing.
 * Once an OSC 7501 report came, OSC 9;4 is no longer followed until a full reset: the spec's "SHOULD stop" — a program
 * that says the full state needs no bar read as one. A new process is a new mirror, so it starts with none.
 */
export class StreamStatus {
  /** Insertion order is update order: a report deletes its id first, so the first entry is the least recently updated. */
  private readonly records = new Map<string, Stamped<ProgramRecord>>();
  private bar: Stamped<ProgressReport> | null = null;
  private lastPercent = 0;
  private programSeen = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** The data of an OSC 9 sequence (only `4;…` counts). */
  osc9(data: string): void {
    if (this.programSeen) return;
    const report = parseProgress(data, this.lastPercent);
    if (!report) return;
    this.lastPercent = report.percent;
    if (report.state === PROGRESS_REMOVE) this.bar = null;
    else this.bar = { ...report, sinceMs: this.bar?.state === report.state ? this.bar.sinceMs : this.now() };
  }

  /** The data of an OSC 7501 sequence. */
  osc7501(data: string): void {
    const report = parseProgramStatus(data);
    if (!report) return;
    this.programSeen = true;
    this.bar = null;
    if (report.state === 'clear') {
      // The record at the id and every record beneath it; the root's id ('') covers them all.
      for (const id of [...this.records.keys()]) {
        if (report.id === '' || id === report.id || id.startsWith(`${report.id}/`)) this.records.delete(id);
      }
      return;
    }
    const before = this.records.get(report.id);
    const sinceMs = before && before.state === report.state && before.kind === report.kind ? before.sinceMs : this.now();
    this.records.delete(report.id);
    const [oldest] = this.records.keys();
    if (oldest !== undefined && this.records.size >= MAX_RECORDS) this.records.delete(oldest);
    this.records.set(report.id, { ...report, sinceMs });
  }

  /** RIS. */
  reset(): void {
    this.records.clear();
    this.bar = null;
    this.lastPercent = 0;
    this.programSeen = false;
  }

  /** What it says now; null when it says nothing. */
  signal(): StreamSignal | null {
    const iso = (ms: number) => new Date(ms).toISOString();
    const top = summarize([...this.records.values()]);
    if (top) {
      const { sinceMs, ...record } = top;
      return { program: { ...record, since: iso(sinceMs) } };
    }
    if (this.bar) {
      const { sinceMs, ...bar } = this.bar;
      return { progress: { ...bar, since: iso(sinceMs) } };
    }
    return null;
  }
}
