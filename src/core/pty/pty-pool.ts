import path from 'node:path';
import type { AgentAdapter } from '../agents/types.js';
import { agentFor, agentSettings, assistantAgent } from '../agents/index.js';
import { statusFromOutput, type PtyOutput } from './output-status.js';
import type { SessionAttention } from '../api-types.js';
import type { HostBeat } from './host-health.js';
import { PtyHostBusyError } from './pty-host-client.js';
import { noClaudeBecause } from '../archive/archiving.js';
import { findSession, sessionIdFor } from '../sessions/web-state.js';
import type { WorktreeSession } from '../sessions/history.js';
import { hostStartLockPath, type SpawnSpec, type HostInfo, type PtyInfo } from './pty-host-protocol.js';
import { dbPtySessions } from './pty-sessions-file.js';
import { ensureFile, withFileLock } from '../platform/fs-safe.js';
import { forgetPersistedSession } from './pty-sessions-file.js';
import { loadConfig } from '../platform/config.js';
import { ensureHost, findHost, PtyHostClient, findHostPatient, PtyHostVersionError } from './pty-host-client.js';
import { logSwallowed, swallow } from '../platform/best-effort.js';
import { ASSISTANT_ID, prepareAssistantDir } from '../agents/assistant.js';

/**
 * `work web`'s view of the Claude PTYs. The PTYs themselves live in the
 * PTY host (`work pty-host`, see core/pty-host.ts), a separate long-lived
 * process — so restarting or rebuilding `work web` never kills an agent,
 * and a real terminal (`work attach`) can share the same session.
 *
 * This module resolves a dashboard session to a spawn spec, asks the host
 * to spawn it on first attach, and keeps a small cache of which sessions
 * have a live PTY for the synchronous badge path (`peekPty`).
 */

let workBin = process.argv[1] ?? '';
let client: PtyHostClient | null = null;
let live = new Set<string>();
/** The pids of those PTYs' processes (the Claudes the app runs). */
let livePids = new Set<number>();
/** Each live PTY's tool and last output (for output-status.ts). */
let outputs = new Map<string, PtyOutput>();
let refreshTimer: NodeJS.Timeout | null = null;
/** The heartbeat (host-health.ts): each list request is one. */
const beat: HostBeat = { known: false, lastOkAt: null, latencyMs: null, lastError: null };

/** How the host answered lately (for GET /api/pty-host/health). */
export function hostBeat(): HostBeat {
  return { ...beat };
}
const REFRESH_MS = 2000;

/** Called by `work web` at startup with the resolved `work` binary path,
 *  which is what the host is spawned from. */
export function configurePtyPool(opts: { workBin: string }): void {
  workBin = opts.workBin;
}

/** The `work` binary path, for routes that launch `work attach`. */
export function getWorkBin(): string {
  return workBin;
}

async function getClient(spawnIfMissing: boolean): Promise<PtyHostClient | null> {
  if (client) {
    // Cheap liveness re-check happens in refresh(); a dead host surfaces
    // as a failed call, which resets `client` below.
    return client;
  }
  const info = spawnIfMissing ? await ensureHost(workBin) : await findHost();
  if (!info) return null;
  client = new PtyHostClient(info);
  startRefresh();
  return client;
}

async function refresh(): Promise<void> {
  const t0 = Date.now();
  try {
    const c = await getClient(false);
    if (!c) {
      beat.known = false;
      live = new Set();
      livePids = new Set();
      outputs = new Map();
      return;
    }
    beat.known = true;
    const ptys = await c.list();
    beat.lastOkAt = Date.now();
    beat.latencyMs = beat.lastOkAt - t0;
    beat.lastError = null;
    live = new Set(ptys.filter((p) => !p.exited).map((p) => p.id));
    livePids = new Set(ptys.filter((p) => !p.exited).map((p) => p.pid));
    outputs = new Map(ptys.filter((p) => !p.exited).map((p) => [p.id, { tool: p.tool, lastOutputAt: p.lastOutputAt, startedAt: p.startedAt }]));
  } catch (err) {
    // Host went away (or was restarted on a new port) — rediscover next tick.
    // A busy host is still a host (it is there, just not answering).
    beat.known = beat.known || err instanceof PtyHostBusyError;
    beat.lastError = (err as Error).message;
    client = null;
    live = new Set();
    livePids = new Set();
    outputs = new Map();
  }
}

function startRefresh(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => void refresh(), REFRESH_MS);
  refreshTimer.unref?.();
}

/** Connect to an already-running host at `work web` startup so badges for
 *  PTYs that survived a web restart show immediately. Never spawns. */
/** Re-read the host's PTY list now (the periodic refresh can be seconds old,
 *  or not have run at all right after `work web` started). */
export async function syncPtyPool(): Promise<void> {
  await refresh();
}

export async function initPtyPool(): Promise<void> {
  await refresh().catch(() => {});
  startRefresh();
}

/**
 * After a reboot (or a host crash) nothing is running but
 * `pty-sessions.json` still lists the sessions that were live. Starting the
 * host restores them; do that when there's something to restore, so
 * reopening `work web` picks up where you left off. Returns how many
 * sessions the host will bring back (0 = nothing to do).
 */
export async function resumePersistedSessions(): Promise<number> {
  let count: number;
  try {
    count = Object.keys(dbPtySessions.read()).length;
  } catch {
    return 0;
  }
  if (count === 0) return 0;
  if (await findHost().catch(() => true)) return 0; // already running
  await getClient(true);
  await refresh();
  return count;
}

/**
 * Where Claude runs for a session — the same directory `work tree` launches
 * in: the worktree for a single repo, the group root (parent of the
 * sub-repos) for a group.
 */
export { ASSISTANT_ID };

/** The assistant runs config `assistantAgent` (Claude Code by default), in its folder written for that agent. */
export function assistantSpec(): { cwd: string; tool: ReturnType<AgentAdapter['launch']['tool']> } {
  const settings = agentSettings();
  const agent = assistantAgent(settings);
  return { cwd: prepareAssistantDir(agent), tool: agent.launch.tool(settings) };
}

export function spawnSpecFor(session: WorktreeSession): SpawnSpec | null {
  const first = session.paths[0];
  if (!first) return null;
  const cwd = session.isGroup ? path.dirname(first) : first;
  const config = loadConfig();
  return { cwd, tool: agentFor(config, session).launch.tool(config), port: session.port };
}

/**
 * Ensure a live PTY exists for the session (spawning Claude in the host if
 * needed) and return the host WebSocket URL to attach to. Null for an
 * unknown session.
 */
export async function ensurePty(
  sessionId: string,
  extra: { initialPrompt?: string } = {},
): Promise<string | null> {
  // The dashboard assistant (Ctrl+K) is not a worktree: it runs in its own
  // folder, which is (re)written first (assistant.ts).
  const session = sessionId === ASSISTANT_ID ? null : findSession(sessionId);
  // Not for a session being archived, or archived: its Claude was stopped on
  // purpose (a Terminal tab still open on it reconnects and would start it).
  const refused = sessionId === ASSISTANT_ID ? null : noClaudeBecause(session, sessionId);
  if (refused) throw new Error(refused);
  const base =
    sessionId === ASSISTANT_ID
      ? assistantSpec()
      : session
        ? spawnSpecFor(session)
        : null;
  if (!base) return null;
  // The first prompt only applies to a fresh spawn (the host ignores the
  // spec when the session's PTY is already running).
  const spec = extra.initialPrompt ? { ...base, initialPrompt: extra.initialPrompt } : base;

  let c = await getClient(true);
  if (!c) return null;
  try {
    await c.spawn(sessionId, spec);
  } catch (err) {
    // Stale client (host restarted on a new port) — retry once, fresh.
    client = null;
    c = await getClient(true);
    if (!c) throw err;
    await c.spawn(sessionId, spec);
  }
  live.add(sessionId);
  return c.attachUrl(sessionId);
}

/** Side-effect-free check: does an active (non-exited) PTY exist for this
 *  session? Served from the refresh cache — used by session-meta for the
 *  "running/idle" badge, which must stay synchronous. */
/** Every PTY in the host, fresh (never starts a host; [] without one). */
export async function listHostPtys(): Promise<PtyInfo[]> {
  const c = await getClient(false);
  return c ? c.list() : [];
}

/** Pids of the Claudes running in the PTY host (from the refresh cache). */
export function ptyPids(): ReadonlySet<number> {
  return livePids;
}

/** A status from its terminal output, for a session whose tool has no hooks (output-status.ts); null for Claude or no PTY. */
export function outputStatus(sessionId: string, now = Date.now()): SessionAttention | null {
  const o = outputs.get(sessionId);
  return o ? statusFromOutput(o, now) : null;
}

export function peekPty(sessionId: string): boolean {
  return live.has(sessionId);
}

/** A session's live PTY screen as text; null when there is none (never spawns). */
export async function readPtyScreen(sessionId: string): Promise<string | null> {
  if (!live.has(sessionId)) return null;
  const c = await getClient(false);
  return c ? c.screen(sessionId) : null;
}

/** Write to a session's live PTY. False when there is none (never spawns). */
export async function writeToPty(sessionId: string, data: string): Promise<boolean> {
  if (!live.has(sessionId)) return false;
  const c = await getClient(false);
  return c ? c.write(sessionId, data) : false;
}

/** Kill one session's PTY (if any). Called before removing a worktree so
 *  the Claude process doesn't hold its cwd open (Windows refuses to delete
 *  a directory that is some process's working directory). */
export async function disposePty(sessionId: string): Promise<void> {
  live.delete(sessionId);
  let c = client;
  if (!c) {
    // A busy host (mid-restore) is waited for, not skipped: skipping left
    // Claude running inside the worktree about to be deleted. A host from
    // another build can't be talked to — nothing to do but proceed.
    let info: HostInfo | null;
    try {
      info = await findHostPatient();
    } catch (err) {
      if (err instanceof PtyHostVersionError) return;
      throw err; // still busy after waiting: let the caller report it
    }
    if (!info) return;
    c = new PtyHostClient(info);
  }
  await c.kill(sessionId).catch(swallow(`stop session ${sessionId} in the PTY host`));
}

/**
 * Stop a session's Claude in the PTY host before its worktree is deleted —
 * from any caller, including the CLI (`work remove` / prune / sync), which
 * doesn't run a pool. Never starts a host; waits for the process to exit
 * (the host's kill does) so Windows can then delete the directory.
 * Best-effort: no host, or a host that can't be reached, is a no-op.
 */
export async function stopSessionPty(target: string, branch: string): Promise<void> {
  const id = sessionIdFor({ target, branch } as WorktreeSession);
  live.delete(id);
  // Under the host START lock: a host that's starting holds it until it has
  // restored, so we either see it running (and kill the session) or know
  // none is — and then drop the session from the saved list so a later
  // start doesn't restore Claude into a worktree that's being deleted.
  const lock = hostStartLockPath();
  ensureFile(lock, '');
  await withFileLock(lock, async () => {
    let info;
    try {
      info = await findHostPatient();
    } catch (err) {
      // A host from another build can't be talked to; one still busy after
      // waiting is running and owns the session — leave both alone (and
      // never drop the saved entry: the host is what it belongs to).
      logSwallowed(`stop session ${id}: PTY host`, err);
      return;
    }
    if (info) await new PtyHostClient(info).kill(id).catch(swallow(`stop session ${id} in the PTY host`));
    else await forgetPersistedSession(id).catch(swallow(`forget saved session ${id}`));
  }).catch(swallow(`stop session ${id}: host start lock`));
}

/** `work web` shutdown. Deliberately does NOT kill anything: the PTYs belong
 *  to the host and outlive the dashboard. Just stops polling. */
export function detachPtyPool(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  client = null;
  live = new Set();
  livePids = new Set();
}
