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
import { hasEnvDelta, type EnvDelta } from '../platform/env-delta.js';
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
/** Whether this server may start the PTY host when none runs (not the dev server: see configurePtyPool). */
let mayStartHost = true;
let client: PtyHostClient | null = null;
let live = new Set<string>();
/** The pids of those PTYs' processes (the Claudes the app runs). */
let livePids = new Set<number>();
/** Each live PTY's tool and last output (for output-status.ts). */
let outputs = new Map<string, PtyOutput & { pid: number }>();
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
export function configurePtyPool(opts: { workBin: string; startHost?: boolean }): void {
  workBin = opts.workBin;
  // The dev server (`work web --dev`) uses the host that runs and never starts one: started
  // from a checkout's build, the long-lived host that owns every Claude would outlive it,
  // and the installed work would become a client of the checkout's code.
  mayStartHost = opts.startHost ?? true;
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
  const info = spawnIfMissing && mayStartHost ? await ensureHost(workBin) : await findHost();
  if (!info && spawnIfMissing && !mayStartHost)
    throw new Error(
      "No PTY host is running, and the dev server doesn't start one: start the installed work (its app or `work web`) first.",
    );
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
    outputs = new Map(
      ptys.filter((p) => !p.exited).map((p) => [p.id, { tool: p.tool, lastOutputAt: p.lastOutputAt, startedAt: p.startedAt, pid: p.pid }]),
    );
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
export function assistantSpec(): { cwd: string; tool: ReturnType<AgentAdapter['launch']['tool']>; agentEnv?: EnvDelta } {
  const settings = agentSettings();
  const agent = assistantAgent(settings);
  // Work's own session, not any session's: the configured default account (`launch.env(null)`).
  const agentEnv = agent.launch.env?.(null);
  return { cwd: prepareAssistantDir(agent), tool: agent.launch.tool(settings), ...(hasEnvDelta(agentEnv) ? { agentEnv } : {}) };
}

export function spawnSpecFor(session: WorktreeSession): SpawnSpec | null {
  const first = session.paths[0];
  if (!first) return null;
  const cwd = session.isGroup ? path.dirname(first) : first;
  const config = loadConfig();
  const launch = agentFor(config, session).launch;
  // The session's account: its agent's folder env, applied by the host over whatever environment it starts with.
  const agentEnv = launch.env?.(session);
  return { cwd, tool: launch.tool(config), port: session.port, ...(hasEnvDelta(agentEnv) ? { agentEnv } : {}) };
}

/**
 * Ensure a live PTY exists for the session (spawning Claude in the host if
 * needed) and return the host WebSocket URL to attach to. Null for an
 * unknown session.
 */
export async function ensurePty(sessionId: string, extra: { initialPrompt?: string } = {}): Promise<string | null> {
  // The dashboard assistant (Ctrl+K) is not a worktree: it runs in its own
  // folder, which is (re)written first (assistant.ts).
  const session = sessionId === ASSISTANT_ID ? null : findSession(sessionId);
  // Not for a session being archived, or archived: its Claude was stopped on
  // purpose (a Terminal tab still open on it reconnects and would start it).
  const refused = sessionId === ASSISTANT_ID ? null : noClaudeBecause(session, sessionId);
  if (refused) throw new Error(refused);
  const base = sessionId === ASSISTANT_ID ? assistantSpec() : session ? spawnSpecFor(session) : null;
  if (!base) return null;
  // The first prompt only applies to a fresh spawn (the host ignores the
  // spec when the session's PTY is already running).
  const spec = extra.initialPrompt ? { ...base, initialPrompt: extra.initialPrompt } : base;

  let c = await getClient(true);
  if (!c) return null;
  // A host from before accounts would start it on its own environment — another account than the session's.
  if (setsEnv(spec.agentEnv) && !(await hostTakesAgentEnv(c)) && !(await runsIn(c, sessionId))) throw new Error(OLD_HOST_ACCOUNTS);
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

/** When a session's terminal last printed (ms, from the refresh cache); null with no PTY or a host that doesn't say. */
export function ptyLastOutputMs(sessionId: string): number | null {
  const at = outputs.get(sessionId)?.lastOutputAt;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Its agent's process id in the host (from the refresh cache); null with no PTY. */
export function ptyPid(sessionId: string): number | null {
  return outputs.get(sessionId)?.pid ?? null;
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

/**
 * Restart a session's agent in the host, resuming its conversation, its terminals
 * kept attached (agent-restart.ts). A host from before that call: stopped and
 * started again (an open Terminal tab then offers Enter, as after a stop).
 */
export async function restartPty(sessionId: string): Promise<string | void> {
  let c = await getClient(false);
  if (!c) throw new Error('the PTY host is not running');
  let how: Awaited<ReturnType<PtyHostClient['restart']>>;
  try {
    how = await c.restart(sessionId);
  } catch (err) {
    // A stale client (the host restarted on a new port before the refresh noticed): once more, fresh.
    client = null;
    c = await getClient(false);
    if (!c) throw err;
    how = await c.restart(sessionId);
  }
  if (how === 'not-running') throw new Error('its agent is not running in the PTY host');
  if (how === 'unsupported') {
    await disposePty(sessionId);
    if (!(await ensurePty(sessionId))) throw new Error('its agent could not be started again');
    return OLD_HOST_RESTART;
  }
}

/**
 * Stop a session's agent and keep its session in the host (entry, restore record, attached terminals) until `resumePty`:
 * a switch of account moves its conversation files in between. `stopped`: a host from before the call stopped it the old
 * way (its terminals were told it ended; `resumePtyOnAccount` then starts it fresh); `gone`: nothing was running.
 */
export async function haltPty(sessionId: string): Promise<'halted' | 'stopped' | 'gone'> {
  let c = await getClient(false);
  if (!c) throw new Error('the PTY host is not running');
  let how: Awaited<ReturnType<PtyHostClient['halt']>>;
  try {
    how = await c.halt(sessionId);
  } catch (err) {
    // A stale client (the host restarted on a new port before the refresh noticed): once more, fresh.
    client = null;
    c = await getClient(false);
    if (!c) throw err;
    how = await c.halt(sessionId);
  }
  if (how === 'not-running') return 'gone';
  if (how === 'unsupported') {
    await disposePty(sessionId);
    return 'stopped';
  }
  return 'halted';
}

/** Why a switch of account can't be done in this PTY host now (it is from before accounts), or null: asked before halting. */
export async function accountSwitchRefusal(): Promise<string | null> {
  const c = await getClient(false);
  return c && !(await hostTakesAgentEnv(c)) ? OLD_HOST_ACCOUNTS : null;
}

/**
 * Start a halted session's agent again in place, on `opts.agentEnv` (its terminals carry on). `not-halted`: it isn't
 * halted any more — the host started it again by itself (HALT_RESUME_MS) or restarted, on its old spec.
 */
export async function resumePty(sessionId: string, opts: { agentEnv?: EnvDelta } = {}): Promise<'resumed' | 'not-halted'> {
  let c = await getClient(false);
  if (!c) throw new Error('the PTY host is not running');
  if (hasEnvDelta(opts.agentEnv) && !(await hostTakesAgentEnv(c))) throw new Error(OLD_HOST_ACCOUNTS);
  let how: Awaited<ReturnType<PtyHostClient['resume']>>;
  try {
    how = await c.resume(sessionId, opts);
  } catch (err) {
    client = null;
    c = await getClient(false);
    if (!c) throw err;
    how = await c.resume(sessionId, opts);
  }
  return how;
}

/**
 * Start the agent of a session `haltPty` stopped, on the account the session records NOW (after a switch: the new one;
 * after one that failed: the old): resumed in place with that environment, or — `stopped`, an older host — started
 * again from a fresh spec (its terminals show it ended; opening the session reconnects).
 */
export async function resumePtyOnAccount(sessionId: string, how: 'halted' | 'stopped'): Promise<string | void> {
  if (how === 'stopped') {
    if (!(await ensurePty(sessionId))) throw new Error('its agent could not be started again');
    return OLD_HOST_RESTART;
  }
  const session = findSession(sessionId);
  const spec = session ? spawnSpecFor(session) : null;
  if (!spec) throw new Error('unknown session');
  // Nothing in the delta means no account change to apply (the default, with no accounts configured): a plain resume.
  const agentEnv = hasEnvDelta(spec.agentEnv) ? spec.agentEnv : undefined;
  if ((await resumePty(sessionId, agentEnv ? { agentEnv } : {})) === 'resumed') return;
  // Started again meanwhile on its OLD spec (the host's own resume after HALT_RESUME_MS — a long move —, or a host
  // restart's restore): restarted in place on the account the session records now, so it doesn't stay on the old one.
  const c = await getClient(false);
  if (!c) throw new Error('the PTY host is not running');
  const restarted = await c.restart(sessionId, agentEnv ? { agentEnv } : {});
  if (restarted === 'restarted') return RESTARTED_AFTER_AUTO_RESUME;
  // Not running now (it ended), or a host that couldn't take the environment in place: started fresh from the new spec.
  if (restarted === 'unsupported') await disposePty(sessionId);
  if (!(await ensurePty(sessionId))) throw new Error('its agent could not be started again');
  return RESTARTED_AFTER_AUTO_RESUME;
}

/** What a switch says when its halted Claude had been started again (on the old account) before the move was done. */
export const RESTARTED_AFTER_AUTO_RESUME =
  'it had been started again on its old account while the conversation moved, so it was restarted on the new one';

/** Said when a session on a named account would start in a PTY host that drops the account (one from before accounts). */
export const OLD_HOST_ACCOUNTS = 'the PTY host is from before Claude accounts: run `work pty-host --restart`';

/** The delta sets a variable (a session on a named account): what an older host would drop, starting it elsewhere. */
const setsEnv = (d: EnvDelta | undefined): boolean => !!d && Object.values(d).some((v) => typeof v === 'string');

/** The host applies `agentEnv`; one that can't be asked right now is given the benefit of the doubt (its restart says). */
async function hostTakesAgentEnv(c: PtyHostClient): Promise<boolean> {
  const f = await c.features();
  return f === null || f.includes('agentEnv');
}

/** Its agent runs in this host now (a spawn would only attach to it). */
async function runsIn(c: PtyHostClient, sessionId: string): Promise<boolean> {
  return (await c.list()).some((p) => p.id === sessionId && !p.exited);
}

/** How a restart on a PTY host from before restart-in-place went: what differs, and the way to the real thing. */
export const OLD_HOST_RESTART =
  'stopped and started again (an older PTY host: open terminals show it ended, and it runs with only the variables `hostEnv` keeps; `work pty-host --restart` gets restarts in place)';

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
