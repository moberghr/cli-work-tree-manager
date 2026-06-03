import fs from 'node:fs';
import net from 'node:net';
import type { WorkConfig } from './config.js';
import type { WorktreeSession } from './history.js';

/** Default dev-server port range when none is configured. */
export const DEFAULT_PORT_RANGE = { start: 3000, end: 3099 };

/**
 * Thrown when every port in the configured range is occupied. Distinct class so
 * callers can tell "range exhausted" apart from any other allocation failure.
 */
export class PortRangeExhaustedError extends Error {
  readonly start: number;
  readonly end: number;
  constructor(start: number, end: number) {
    super(
      `No free dev-server port available in range ${start}-${end} ` +
        `(all ${end - start + 1} in use). Widen "portRange" in ~/.work/config.json.`,
    );
    this.name = 'PortRangeExhaustedError';
    this.start = start;
    this.end = end;
  }
}

/**
 * Deterministic, stable string hash (FNV-1a 32-bit). Same input always yields
 * the same non-negative integer, so a worktree's seed key maps to the same base
 * offset across processes and machines.
 */
function hashString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeRange(config: Pick<WorkConfig, 'portRange'>): {
  start: number;
  end: number;
  rangeSize: number;
} {
  const range = config.portRange ?? DEFAULT_PORT_RANGE;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const rangeSize = end - start + 1;
  if (rangeSize <= 0) {
    throw new Error(`Invalid port range: ${range.start}-${range.end}`);
  }
  return { start, end, rangeSize };
}

function portsHeldByActiveSessions(sessions: WorktreeSession[]): Set<number> {
  const inUse = new Set<number>();
  for (const session of sessions) {
    if (session.port === undefined) continue;
    const active = session.paths.some((p) => fs.existsSync(p));
    if (active) inUse.add(session.port);
  }
  return inUse;
}

/**
 * Allocate a stable dev-server port for a worktree.
 *
 * Pure and testable: the caller passes the current `sessions` array (e.g.
 * `loadHistory()`) rather than this function reading state itself.
 *
 * - The range comes from `config.portRange` (falling back to 3000–3099).
 * - A deterministic base offset is derived from `hash(seedKey) % rangeSize`,
 *   so the same worktree prefers the same port. The seed key MUST be unique per
 *   worktree (e.g. `target:branch` or the full worktree path) — using only a
 *   branch name would let two repos sharing a branch collide deterministically.
 * - Ports already held by *active* sessions (at least one path still exists)
 *   are considered in use and skipped.
 * - Walks forward from the base offset (wrapping around the range) to the first
 *   free port. Throws `PortRangeExhaustedError` if every port is occupied.
 *
 * NOTE: this checks only our own history, not host liveness. Use
 * `allocateFreePort` when you also want to skip ports occupied by unrelated
 * processes on the machine.
 */
export function allocatePort(
  seedKey: string,
  config: Pick<WorkConfig, 'portRange'>,
  sessions: WorktreeSession[],
): number {
  const { start, end, rangeSize } = normalizeRange(config);
  const inUse = portsHeldByActiveSessions(sessions);
  const baseOffset = hashString(seedKey) % rangeSize;

  for (let i = 0; i < rangeSize; i++) {
    const candidate = start + ((baseOffset + i) % rangeSize);
    if (!inUse.has(candidate)) {
      return candidate;
    }
  }

  throw new PortRangeExhaustedError(start, end);
}

/**
 * Probe whether a TCP port is free to bind on localhost. Resolves false on
 * EADDRINUSE (something is already listening), true otherwise. Best-effort: any
 * non-EADDRINUSE error resolves true so a quirky host can't block allocation.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code !== 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Like `allocatePort`, but additionally probes host liveness: candidates that
 * are already bound by some other process on localhost (EADDRINUSE) are skipped
 * even when our history doesn't know about them. This is what actually prevents
 * collisions with non-work processes.
 *
 * Walks the same deterministic order as `allocatePort` and returns the first
 * candidate that is both free in history and bindable on the host. Throws
 * `PortRangeExhaustedError` if every candidate is taken.
 */
export async function allocateFreePort(
  seedKey: string,
  config: Pick<WorkConfig, 'portRange'>,
  sessions: WorktreeSession[],
  probe: (port: number) => Promise<boolean> = isPortFree,
): Promise<number> {
  const { start, end, rangeSize } = normalizeRange(config);
  const inUse = portsHeldByActiveSessions(sessions);
  const baseOffset = hashString(seedKey) % rangeSize;

  for (let i = 0; i < rangeSize; i++) {
    const candidate = start + ((baseOffset + i) % rangeSize);
    if (inUse.has(candidate)) continue;
    if (await probe(candidate)) {
      return candidate;
    }
  }

  throw new PortRangeExhaustedError(start, end);
}
