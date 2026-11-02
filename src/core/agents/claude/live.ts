import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootTime, processTable } from '../../platform/process.js';
import { claudeAccounts } from './accounts.js';
import type { LiveAgent } from '../types.js';

/**
 * Claude Code's running processes (the Claude adapter's `live`): which
 * Claudes are running right now, wherever they were started — your
 * terminal tabs included, which the dashboard otherwise only knows about
 * through hooks and transcript writes (an idle one produces neither).
 *
 * Claude Code keeps a file per running interactive/headless Claude in
 * ~/.claude/sessions/<pid>.json (pid, conversation id, cwd, busy/idle).
 * That is Claude Code's own file, not a documented interface, so it is read
 * defensively: anything without the fields we need is skipped, and if the
 * format changes the signal just goes quiet — nothing else depends on it.
 * A pid is believed only if a process with a Claude-ish name runs under it
 * and the file was written since this boot (pids are reused, fast on
 * Windows — §1.6).
 */

type LiveClaude = LiveAgent;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** One ~/.claude/sessions/<pid>.json, or null if it lacks what we need. */
export function parseLiveClaude(raw: unknown): LiveClaude | null {
  if (!isObj(raw)) return null;
  const { pid, sessionId, cwd, status, startedAt, statusUpdatedAt, waitingFor } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) return null;
  return {
    pid,
    conversationId: sessionId,
    cwd,
    busy: status === 'busy',
    state: status === 'busy' || status === 'idle' || status === 'waiting' ? status : null,
    stateAt: typeof statusUpdatedAt === 'number' ? statusUpdatedAt : null,
    waitingFor: typeof waitingFor === 'string' && waitingFor ? waitingFor : null,
    startedAt: typeof startedAt === 'number' ? startedAt : null,
  };
}

/** The executable a running Claude shows up as (native build, or via node). */
const CLAUDE_EXE = /^(claude|node)(\.exe)?$/i;

/** Keep the ones whose pid is a live Claude started since this boot. */
export function aliveOnly(list: LiveClaude[], table: ReadonlyMap<number, string>, bootMs: number): LiveClaude[] {
  return list.filter((c) => {
    const name = table.get(c.pid);
    if (!name || !CLAUDE_EXE.test(name)) return false;
    return c.startedAt === null || c.startedAt >= bootMs - 60_000;
  });
}

// ------------------------------------------------------------------ reading

const TTL_MS = 5000;
let cache: { at: number; key: string; list: LiveClaude[] } | null = null;

export function claudeSessionsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

/**
 * Where running Claudes write their process files: every account's `sessions/` folder. With no account configured it is
 * the one folder it always was (`claudeSessionsDir`, which follows a `CLAUDE_CONFIG_DIR` the user set themselves).
 */
export function claudeSessionsDirs(): string[] {
  const accounts = claudeAccounts();
  if (accounts.length <= 1) return [claudeSessionsDir()];
  return [...new Set(accounts.map((a) => path.join(a.dir, 'sessions')))];
}

/** One folder's process files that are live Claudes. */
function readDir(dir: string, table: () => ReadonlyMap<number, string>): LiveClaude[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    return [];
  }
  const parsed: LiveClaude[] = [];
  for (const n of names) {
    try {
      const c = parseLiveClaude(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as unknown);
      if (c) parsed.push(c);
    } catch {
      /* half-written or not ours: skip */
    }
  }
  return parsed.length ? aliveOnly(parsed, table(), bootTime()) : [];
}

/**
 * The running Claudes (cached for a few seconds: this lists every process), of every account — or of one `dir` when
 * given. With `table`, a process table the caller already has (the session list's background one): read against it,
 * and neither read nor written to the cache — the guard against a second Claude keeps its own, synchronous view.
 */
export function readLiveClaudes(dir?: string, now = Date.now(), table?: ReadonlyMap<number, string>): LiveClaude[] {
  const dirs = dir ? [dir] : claudeSessionsDirs();
  const key = dirs.join('|');
  // Only the whole list is cached; one folder asked for by name is read as it is.
  const cached = !table && !dir;
  if (cached && cache && now - cache.at < TTL_MS && cache.key === key) return cache.list;
  // The process table is read once, and only when a folder has a process file to check.
  let procs: ReadonlyMap<number, string> | undefined = table;
  const procTable = () => (procs ??= processTable());
  const list = dirs.flatMap((d) => readDir(d, procTable));
  if (cached) cache = { at: now, key, list };
  return list;
}
