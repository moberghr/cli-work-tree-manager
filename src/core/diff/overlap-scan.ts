import path from 'node:path';
import { computeChanges, wantsDiffStat } from './diff-stat.js';
import { findOverlaps } from './overlap.js';
import { pool } from '../cleanup/cleanup.js';
import { sessionIdFor } from '../sessions/session-id.js';
import { defaultRunner, type CommandRunner } from '../pr/ship.js';
import type { WorktreeSession } from '../sessions/history.js';
import type { DiffStat, SessionOverlap } from '../api-types.js';

/**
 * Each live session's `+N −M` and which sessions change the same files,
 * computed now. The dashboard gets the same answers from its background
 * diff-stat cache; the CLI has no cache, so it runs the git itself — one
 * pass per repo of each live session, giving both at once.
 */
export async function scanChanges(
  sessions: WorktreeSession[],
  opts: { run?: CommandRunner; concurrency?: number; hasStatus?: (id: string) => boolean } = {},
): Promise<{ stats: Map<string, DiffStat | null>; overlaps: Map<string, SessionOverlap[]> }> {
  const run = opts.run ?? defaultRunner;
  const live = sessions.filter((s) => wantsDiffStat(s, opts.hasStatus?.(sessionIdFor(s)) ?? false));
  const stats = new Map<string, DiffStat | null>();
  const files: Parameters<typeof findOverlaps>[0] = [];
  await pool(live, opts.concurrency ?? 6, async (s) => {
    const id = sessionIdFor(s);
    const names = s.isGroup ? s.paths.map((p) => path.basename(p)) : [s.target];
    const { stat, touched } = await computeChanges(s.paths, names, run);
    stats.set(id, stat);
    files.push({ id, target: s.target, branch: s.branch, touched });
  });
  return { stats, overlaps: findOverlaps(files) };
}
