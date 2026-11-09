import type { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDir } from './config.js';
import { atomicWriteFile } from './fs-safe.js';

/**
 * How the last work web ended, so a crash isn't a mystery. Each work web
 * keeps a small record (`~/.work/web-life.json`): its pid, when it started,
 * when it was last seen alive (a heartbeat), and — when it ends on its own —
 * how (exit code, signal, a replacement). One that vanishes without writing
 * its end was killed outright (TerminateProcess, a closed job, the machine
 * stopping), which leaves nothing in the log: the next one says so, with the
 * last time it was seen.
 */

export interface WebLife {
  pid: number;
  version: string;
  startedAt: string;
  lastSeen: string;
  /** Set when it ended on its own. */
  ended?: { at: string; how: string };
}

const lifePath = () => path.join(getConfigDir(), 'web-life.json');

function isLife(v: unknown): v is WebLife {
  const l = v as Partial<WebLife> | null;
  return (
    !!l &&
    typeof l === 'object' &&
    typeof l.pid === 'number' &&
    typeof l.version === 'string' &&
    typeof l.startedAt === 'string' &&
    typeof l.lastSeen === 'string' &&
    (l.ended === undefined || (typeof l.ended?.at === 'string' && typeof l.ended?.how === 'string'))
  );
}

export function readWebLife(): WebLife | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(lifePath(), 'utf-8'));
    return isLife(v) ? v : null;
  } catch {
    return null;
  }
}

function write(life: WebLife): void {
  try {
    atomicWriteFile(lifePath(), JSON.stringify(life));
  } catch {
    /* best effort: the record only explains, nothing depends on it */
  }
}

/**
 * What the record of the last work web says about how it ended, in a line, or
 * null when there's nothing to say: none before, it ended on its own (that's in
 * the log already), or it is still running (a second one starting beside it). Pure.
 */
export function previousEnd(prev: WebLife | null, alive: (pid: number) => boolean, myPid: number): string | null {
  if (!prev || prev.ended || prev.pid === myPid || alive(prev.pid)) return null;
  return (
    `the work web before this one (${prev.version}, pid ${prev.pid}, up since ${prev.startedAt}) ended without saying how — ` +
    `last seen alive at ${prev.lastSeen}. It was stopped from outside (killed, or the app or the machine went down with it), not by an error of its own.`
  );
}

/** This work web's record, started now; `beat` keeps it current, `end` says how it ended. */
export function startWebLife(version: string, now: () => Date = () => new Date()): { beat: () => void; end: (how: string) => void } {
  const life: WebLife = { pid: process.pid, version, startedAt: now().toISOString(), lastSeen: now().toISOString() };
  write(life);
  let ended = false;
  return {
    beat: () => {
      if (ended) return;
      life.lastSeen = now().toISOString();
      write(life);
    },
    // The first word wins: a signal's "stopping on SIGTERM" before the exit that follows it.
    end: (how) => {
      if (ended) return;
      ended = true;
      life.lastSeen = now().toISOString();
      write({ ...life, ended: { at: life.lastSeen, how } });
    },
  };
}

/** The signals that stop a work web, and how each is said (Windows: a closed console is SIGHUP, Ctrl+Break SIGBREAK). */
export const STOP_SIGNALS = {
  SIGINT: 'stopped on SIGINT (Ctrl+C)',
  SIGTERM: 'stopped on SIGTERM',
  SIGHUP: 'stopped on SIGHUP (its console closed)',
  SIGBREAK: 'stopped on SIGBREAK (Ctrl+Break)',
} as const;

type Emitter = Pick<EventEmitter, 'on'>;

/** Every exit says how it ended: the exit code, unless something said more first (`end`'s first word wins). */
export function recordExit(proc: Emitter, life: { end: (how: string) => void }): void {
  proc.on('exit', (code: number) => life.end(`exited with code ${code}`));
}

/** Each stop signal runs `stop` with how it was said. Wired once `stop` is real: a listener replaces Node's own exit. */
export function stopOnSignals(proc: Emitter, stop: (how: string) => void): void {
  for (const [sig, how] of Object.entries(STOP_SIGNALS)) proc.on(sig, () => stop(how));
}
