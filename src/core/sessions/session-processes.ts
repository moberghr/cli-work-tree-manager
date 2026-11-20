import type { SessionProcessWire, SessionProcessesWire } from '../api-types.js';
import type { ProcessUsage } from '../platform/process-usage.js';
import { describeProcess, isPtyHelper, normDir, runsFrom } from '../platform/running-from.js';
import { LEFTOVER_AFTER_MS } from './process-view.js';

/**
 * What a session costs right now: its agent and everything the agent started (its children, all the way down), plus
 * what runs from its folders whoever started it — each with its memory and how long it has run (reported: four dev
 * servers a session's agent had started two days before held 3 GB, and nothing said so). One left running a day that
 * isn't the agent itself is marked a leftover: the usual forgotten dev server or watcher. Pure.
 */

export { LEFTOVER_AFTER_MS };

/** Every descendant of `roots` (the roots too), by the parent each process names. Pure. */
export function descendantsOf(procs: readonly ProcessUsage[], roots: ReadonlySet<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const out = new Set<number>();
  const todo = [...roots].filter((r) => procs.some((p) => p.pid === r));
  while (todo.length) {
    const pid = todo.pop()!;
    if (out.has(pid)) continue;
    out.add(pid);
    todo.push(...(children.get(pid) ?? []));
  }
  return out;
}

/**
 * The session's processes, most memory first, with the total. `agentPids`: its agent's own process(es) (the PTY
 * host's); `dirs`: its folders. A parent is believed only when it started before its child: pids are reused, and a
 * long-gone parent's number can belong to something else now.
 */
export function sessionProcesses(
  procs: readonly ProcessUsage[],
  opts: { agentPids: ReadonlySet<number>; dirs: readonly string[]; now: number; windows?: boolean },
): SessionProcessesWire {
  const windows = opts.windows ?? process.platform === 'win32';
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  // A child older than its "parent" was started by an earlier process of that number.
  const real = procs.map((p) => {
    const parent = byPid.get(p.ppid);
    const stale = parent && p.startedAt !== null && parent.startedAt !== null && parent.startedAt > p.startedAt + 1000;
    return stale ? { ...p, ppid: 0 } : p;
  });
  const tree = descendantsOf(real, opts.agentPids);
  const dirs = opts.dirs.map((d) => normDir(d, windows));
  const mine = real.filter((p) => !isPtyHelper(p) && (tree.has(p.pid) || (dirs.length > 0 && runsFrom(p, dirs, windows))));
  const rows: SessionProcessWire[] = mine
    .map((p) => {
      const agent = opts.agentPids.has(p.pid);
      const ageMs = p.startedAt === null ? null : Math.max(0, opts.now - p.startedAt);
      return {
        pid: p.pid,
        // Its name and command with the session's folder shortened, without the pid (it has its own field).
        what: describeProcess(p, dirs, windows).replace(/ \(PID \d+\)$/, ''),
        memBytes: p.memBytes,
        startedAt: p.startedAt,
        ...(agent ? { agent: true as const } : {}),
        ...(!agent && ageMs !== null && ageMs >= LEFTOVER_AFTER_MS ? { leftover: true as const } : {}),
      };
    })
    .sort((a, b) => (b.memBytes ?? 0) - (a.memBytes ?? 0) || a.pid - b.pid);
  return {
    at: opts.now,
    totalBytes: rows.reduce((n, r) => n + (r.memBytes ?? 0), 0),
    leftovers: rows.filter((r) => r.leftover).length,
    processes: rows,
  };
}

export { stopRefusal } from './process-stop.js';
