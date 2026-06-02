import fs from 'node:fs';
import type { WorkConfig } from './config.js';
import type { WorktreeSession } from './history.js';

/** Default dev-server port range when none is configured. */
export const DEFAULT_PORT_RANGE = { start: 3000, end: 3099 };

/**
 * Deterministic, stable string hash (FNV-1a 32-bit). Same input always yields
 * the same non-negative integer, so a worktree name maps to the same base
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

/**
 * Allocate a stable dev-server port for a worktree.
 *
 * Pure and testable: the caller passes the current `sessions` array (e.g.
 * `loadHistory()`) rather than this function reading state itself.
 *
 * - The range comes from `config.portRange` (falling back to 3000–3099).
 * - A deterministic base offset is derived from `hash(worktreeName) % rangeSize`,
 *   so the same name prefers the same port.
 * - Ports already held by *active* sessions (at least one path still exists)
 *   are considered in use and skipped.
 * - Walks forward from the base offset (wrapping around the range) to the first
 *   free port. Throws if every port in the range is occupied.
 */
export function allocatePort(
  worktreeName: string,
  config: Pick<WorkConfig, 'portRange'>,
  sessions: WorktreeSession[],
): number {
  const range = config.portRange ?? DEFAULT_PORT_RANGE;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const rangeSize = end - start + 1;

  if (rangeSize <= 0) {
    throw new Error(`Invalid port range: ${range.start}-${range.end}`);
  }

  const inUse = new Set<number>();
  for (const session of sessions) {
    if (session.port === undefined) continue;
    const active = session.paths.some((p) => fs.existsSync(p));
    if (active) inUse.add(session.port);
  }

  const baseOffset = hashString(worktreeName) % rangeSize;

  for (let i = 0; i < rangeSize; i++) {
    const candidate = start + ((baseOffset + i) % rangeSize);
    if (!inUse.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `No free dev-server port available in range ${start}-${end} (all ${rangeSize} in use)`,
  );
}
