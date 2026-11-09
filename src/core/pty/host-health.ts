/**
 * PURE — how the PTY host (the process every Claude runs in) is doing, from
 * the pool's heartbeat (it asks the host for its PTY list every 2 s): fine,
 * slow to answer, or not answering — the dashboard says so instead of
 * terminals that quietly stop. Import-free (the SPA uses the labels).
 */

export interface HostBeat {
  /** A host was found (its discovery file answered, or it is busy). */
  known: boolean;
  /** When it last answered (ms), and how long that took. */
  lastOkAt: number | null;
  latencyMs: number | null;
  /** The last failure's reason, when it failed since. */
  lastError: string | null;
  /** The work release the host runs: '' for a host from before it said, null unknown (not asked yet). Absent: older pool. */
  hostVersion?: string | null;
}

export type HostState = 'ok' | 'slow' | 'unresponsive' | 'none';

/** Not answering for this long: unresponsive (VS Code's ~11 s). */
export const UNRESPONSIVE_MS = 11_000;
/** An answer that took this long: slow. */
export const SLOW_MS = 1_500;

export interface HostHealth {
  state: HostState;
  latencyMs: number | null;
  /** How long since it last answered (ms), when it ever did. */
  quietMs: number | null;
  error: string | null;
  /**
   * The host runs another release than this work (it outlives updates: an old one keeps old bugs) — what it runs
   * ('an older version' for one from before it said). Null when the same, or unknown. Absent from an older server.
   */
  outdated?: string | null;
}

export function hostHealth(b: HostBeat, now = Date.now(), running?: string): HostHealth {
  const quietMs = b.lastOkAt === null ? null : Math.max(0, now - b.lastOkAt);
  const state: HostState = !b.known
    ? 'none'
    : quietMs === null || quietMs > UNRESPONSIVE_MS
      ? 'unresponsive'
      : (b.latencyMs ?? 0) > SLOW_MS
        ? 'slow'
        : 'ok';
  const v = b.hostVersion;
  // A dev build ('dev', or a checkout's '-dev.' describe) on either side says nothing: those differ all day.
  const comparable = !!running && running !== 'dev' && !running.includes('-dev.') && v !== null && v !== undefined && !v.includes('-dev.');
  const outdated = state !== 'none' && comparable && v !== running ? v || 'an older version' : null;
  return { state, latencyMs: b.latencyMs, quietMs, error: state === 'ok' ? null : b.lastError, outdated };
}

/** For the top bar; null when there is nothing to say. */
export function hostHealthText(h: HostHealth): string | null {
  if (h.state === 'unresponsive')
    return `Terminal host not answering${h.quietMs !== null ? ` (${Math.round(h.quietMs / 1000)} s)` : ''} — terminals may be frozen; restarting it brings them back (sessions resume)`;
  if (h.state === 'slow') return `Terminal host slow to answer (${Math.round((h.latencyMs ?? 0) / 100) / 10} s)`;
  if (h.outdated)
    return `The terminal host still runs ${h.outdated}, from before the update — restart it to get the fixes (sessions resume where they were)`;
  return null;
}

/** The banner offers Restart: the host is stuck, or older than this work. */
export function hostNeedsRestart(h: HostHealth): boolean {
  return h.state === 'unresponsive' || !!h.outdated;
}
