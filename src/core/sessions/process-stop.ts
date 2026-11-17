import type { SessionProcessesWire } from '../api-types.js';

/**
 * May this pid be stopped as one of the session's? Only one the listing has now, that isn't the agent (stopping its
 * agent is the session's own action), and that started when the caller saw it start — the pid may be another process
 * by now (§1.6). Null when it may, else why not. Pure (the demo uses it too).
 */
export function stopRefusal(now: SessionProcessesWire, pid: number, startedAt: number | null): string | null {
  const p = now.processes.find((x) => x.pid === pid);
  if (!p) return 'it is no longer running for this session';
  if (p.agent) return 'that is its agent: stop it from the session instead';
  if (p.startedAt === null || startedAt === null || Math.abs(p.startedAt - startedAt) > 2000)
    return 'the process under that number is not the one that was listed';
  return null;
}
