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
}

export function hostHealth(b: HostBeat, now = Date.now()): HostHealth {
  const quietMs = b.lastOkAt === null ? null : Math.max(0, now - b.lastOkAt);
  const state: HostState = !b.known
    ? 'none'
    : quietMs === null || quietMs > UNRESPONSIVE_MS
      ? 'unresponsive'
      : (b.latencyMs ?? 0) > SLOW_MS
        ? 'slow'
        : 'ok';
  return { state, latencyMs: b.latencyMs, quietMs, error: state === 'ok' ? null : b.lastError };
}

/** For the top bar; null when there is nothing to say. */
export function hostHealthText(h: HostHealth): string | null {
  if (h.state === 'unresponsive') return `Terminal host not answering${h.quietMs !== null ? ` (${Math.round(h.quietMs / 1000)} s)` : ''} — terminals may be frozen; \`work pty-host --restart\` brings them back`;
  if (h.state === 'slow') return `Terminal host slow to answer (${Math.round((h.latencyMs ?? 0) / 100) / 10} s)`;
  return null;
}
