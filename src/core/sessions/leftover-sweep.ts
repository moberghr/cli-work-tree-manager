import type { ProcessUsage } from '../platform/process-usage.js';
import { formatBytes } from './process-view.js';
import { sessionProcesses } from './session-processes.js';

/**
 * Now and then, look for what sessions left running: something an agent started (a dev server, a watcher) that has
 * run for over a day. Nothing is stopped — it may be the dev server you use — but the Activity panel says which
 * session holds how much, so memory doesn't go quietly (reported: four dev servers left for two days held 3 GB).
 * The policy, with its I/O passed in; work web runs it (one process listing for every session).
 */
export interface LeftoverSweepDeps {
  /** The live sessions: id, how the dashboard names it, its folders. */
  sessions: () => Array<{ id: string; name: string; paths: string[] }>;
  /** Every process with its memory and start time; [] when they can't be read. */
  list: () => Promise<ProcessUsage[]>;
  /** A session's agent process in the PTY host, when it runs there. */
  agentPid: (sessionId: string) => number | null;
  /** One finding, for the Activity panel. */
  note: (text: string, opts: { level: 'warn'; sessionId: string }) => void;
  now?: () => number;
}

/** What a sweep found: how many sessions hold leftovers, and how much; null when the processes couldn't be read. */
export async function sweepLeftovers(deps: LeftoverSweepDeps): Promise<{ sessions: number; processes: number; bytes: number } | null> {
  const procs = await deps.list();
  if (procs.length === 0) return null;
  const now = (deps.now ?? Date.now)();
  const found = { sessions: 0, processes: 0, bytes: 0 };
  for (const s of deps.sessions()) {
    const pid = deps.agentPid(s.id);
    const left = sessionProcesses(procs, { agentPids: new Set(pid ? [pid] : []), dirs: s.paths, now }).processes.filter((p) => p.leftover);
    if (left.length === 0) continue;
    const bytes = left.reduce((n, p) => n + (p.memBytes ?? 0), 0);
    found.sessions++;
    found.processes += left.length;
    found.bytes += bytes;
    const names = left.slice(0, 2).map((p) => p.what);
    deps.note(
      `${s.name}: ${left.length} process${left.length === 1 ? '' : 'es'} left running for over a day (${formatBytes(bytes)}): ${names.join('; ')}${left.length > 2 ? ` and ${left.length - 2} more` : ''} — its ⋯ menu → Processes… stops them`,
      { level: 'warn', sessionId: s.id },
    );
  }
  return found;
}

/** The sweep's one-line outcome. Pure. */
export function leftoverSummary(found: { sessions: number; processes: number; bytes: number } | null): string {
  if (!found) return "couldn't read the running processes";
  if (found.processes === 0) return 'nothing left running for over a day';
  return `${found.processes} process${found.processes === 1 ? '' : 'es'} left running for over a day in ${found.sessions} session${found.sessions === 1 ? '' : 's'} (${formatBytes(found.bytes)})`;
}
