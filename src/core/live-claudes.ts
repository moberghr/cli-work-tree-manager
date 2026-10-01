import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionClaudes } from './api-types.js';
import type { WorktreeSession } from './history.js';
import { findSessionForCwd } from './pending-delivery.js';
import { bootTime, processTable } from './process.js';
import { sessionIdFor } from './session-id.js';

/**
 * Which Claudes are running right now, wherever they were started — your
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

export interface LiveClaude {
  pid: number;
  /** Claude's conversation (session) id. */
  conversationId: string;
  cwd: string;
  busy: boolean;
  startedAt: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** One ~/.claude/sessions/<pid>.json, or null if it lacks what we need. */
export function parseLiveClaude(raw: unknown): LiveClaude | null {
  if (!isObj(raw)) return null;
  const { pid, sessionId, cwd, status, startedAt } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof sessionId !== 'string' || !sessionId || typeof cwd !== 'string' || !cwd) return null;
  return {
    pid,
    conversationId: sessionId,
    cwd,
    busy: status === 'busy',
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

/** Group by work session (a Claude outside any session is left out). */
export function claudesBySession(list: LiveClaude[], sessions: WorktreeSession[]): Map<string, LiveClaude[]> {
  const out = new Map<string, LiveClaude[]>();
  for (const c of list) {
    const s = findSessionForCwd(c.cwd, sessions);
    if (!s) continue;
    const id = sessionIdFor(s);
    out.set(id, [...(out.get(id) ?? []), c]);
  }
  return out;
}

/**
 * What the dashboard says about a session's running Claudes. `appPids` are
 * the ones the app runs itself (the PTY host's, the chat's); the rest were
 * started in a terminal. `duplicate`: two or more on one conversation — they
 * would both write to it.
 */
export function summarizeClaudes(list: LiveClaude[], appPids: ReadonlySet<number>): SessionClaudes | null {
  if (list.length === 0) return null;
  const inApp = list.filter((c) => appPids.has(c.pid)).length;
  const perConversation = new Map<string, number>();
  for (const c of list) perConversation.set(c.conversationId, (perConversation.get(c.conversationId) ?? 0) + 1);
  return {
    inTerminal: list.length - inApp,
    inApp,
    busy: list.some((c) => c.busy),
    duplicate: [...perConversation.values()].some((n) => n > 1),
  };
}

// ------------------------------------------------------------------ reading

const TTL_MS = 5000;
let cache: { at: number; list: LiveClaude[] } | null = null;

export function claudeSessionsDir(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
}

/**
 * The running Claudes (cached for a few seconds: this lists every process).
 * With `table`, a process table the caller already has (the session list's
 * background one): read against it, and neither read nor written to the
 * cache — the guard against a second Claude keeps its own, synchronous view.
 */
export function readLiveClaudes(dir = claudeSessionsDir(), now = Date.now(), table?: ReadonlyMap<number, string>): LiveClaude[] {
  if (!table && cache && now - cache.at < TTL_MS && dir === claudeSessionsDir()) return cache.list;
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
  const list = parsed.length ? aliveOnly(parsed, table ?? processTable(), bootTime()) : [];
  if (!table) cache = { at: now, list };
  return list;
}
