import fs from 'node:fs';
import { findOnPath } from '../platform/find-on-path.js';
import type { PtyInfo } from './pty-host-protocol.js';

/**
 * Restarting the agents in the PTY host — after their tool updated (Claude Code
 * replaced its binary; a running Claude keeps the old one until it starts again),
 * or when asked. A restart is its agent stopped and started again in place,
 * resuming its conversation; never in the middle of a turn: a session working or
 * waiting on you restarts when its turn ends.
 */

/**
 * When the file a tool's command runs was installed: the newest of its change and
 * modification times (npm unpacks files with an old mtime; replacing or unpacking
 * a file moves its change time), following links (`~/.local/bin/claude` →
 * `versions/2.1.296`). Null when it isn't on PATH.
 */
export function installedAt(cmd: string, find: (cmd: string) => string | null = findOnPath): number | null {
  const file = find(cmd);
  if (!file) return null;
  try {
    const st = fs.statSync(fs.realpathSync(file));
    return Math.max(st.mtimeMs, st.ctimeMs);
  } catch {
    return null;
  }
}

/**
 * The live PTYs whose process started before its tool's file was installed: they
 * run the version from before. A PTY whose tool isn't known (a host from before
 * `tool`) or isn't on PATH is left out: nothing says it's outdated. Pure.
 */
export function outdatedPtys(ptys: readonly PtyInfo[], toolInstalledAt: (tool: string) => number | null): PtyInfo[] {
  return ptys.filter((p) => {
    if (p.exited || !p.tool) return false;
    const at = toolInstalledAt(p.tool);
    const started = Date.parse(p.startedAt);
    return at !== null && Number.isFinite(started) && started < at;
  });
}

/** How recently a terminal printed for its agent to count as at work: a working one redraws its spinner, an idle one prints nothing. */
export const PRINTING_MS = 10_000;

/**
 * At work, for a restart: its status (the hooks' as the dashboard reads it, corrected by the transcript and
 * decayed) is working or waiting on you — or its terminal printed in the last few seconds, which is all an
 * agent with no status has (the Ctrl+K assistant, a tool with no hooks) and catches a turn the hooks missed. Pure.
 */
export function busyForRestart(state: 'working' | 'needs_input' | 'idle' | null, lastOutputMs: number | null, now = Date.now()): boolean {
  if (state === 'working' || state === 'needs_input') return true;
  return lastOutputMs !== null && now - lastOutputMs < PRINTING_MS;
}

/** Which of `ids` restart now and which after their turn (working, or waiting on you). Pure. */
export function restartPlan(ids: readonly string[], busy: (id: string) => boolean): { now: string[]; later: string[] } {
  const now: string[] = [];
  const later: string[] = [];
  for (const id of new Set(ids)) (busy(id) ? later : now).push(id);
  return { now, later };
}

/** Restarts run this many at a time. */
export const RESTART_AT_ONCE = 3;

export interface RestarterDeps {
  /** Restart its agent in place (the host keeps attached terminals). */
  restart: (id: string) => Promise<void>;
  /** Working, or waiting on you: not now. */
  busy: (id: string) => boolean;
  /** Its agent runs in the host (a queued one stopped meanwhile needs nothing). */
  running: (id: string) => boolean;
  /** One line per decision (the Activity panel), and a change worth showing. */
  note?: (id: string, text: string, level: 'action' | 'info' | 'warn') => void;
  changed?: () => void;
}

export interface RestartOutcome {
  now: string[];
  later: string[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Restarts now what can go now, and the rest when their turn ends (`turnEnded`,
 * from the status hook) — or on a later `retry` (a turn whose end no hook
 * reported). One restart per session at a time.
 */
export function createRestarter(deps: RestarterDeps) {
  const queued = new Set<string>();
  const inFlight = new Set<string>();

  const one = async (id: string, failed: RestartOutcome['failed']): Promise<boolean> => {
    if (inFlight.has(id)) return true;
    inFlight.add(id);
    queued.delete(id);
    try {
      await deps.restart(id);
      deps.note?.(id, 'restarted its agent (its conversation goes on)', 'action');
      return true;
    } catch (err) {
      const error = (err as Error).message;
      failed.push({ id, error });
      deps.note?.(id, `couldn't restart its agent: ${error}`, 'warn');
      return false;
    } finally {
      inFlight.delete(id);
    }
  };

  const request = async (ids: readonly string[]): Promise<RestartOutcome> => {
    const { now, later } = restartPlan(
      ids.filter((id) => deps.running(id)),
      deps.busy,
    );
    const failed: RestartOutcome['failed'] = [];
    for (const id of later) {
      queued.add(id);
      deps.note?.(id, 'restarts its agent when its turn ends (it is working or waiting on you)', 'info');
    }
    // A few at a time: each waits for its old process to exit, and a dozen one after another outlast the caller.
    const ok = new Set<string>();
    const queue = [...now];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) if (await one(id, failed)) ok.add(id);
    };
    await Promise.all(Array.from({ length: Math.min(RESTART_AT_ONCE, queue.length) }, worker));
    const done = now.filter((id) => ok.has(id));
    if (done.length || later.length) deps.changed?.();
    return { now: done, later, failed };
  };

  /** Restart the queued ones that can go now. */
  const retry = async (only?: string): Promise<void> => {
    const failed: RestartOutcome['failed'] = [];
    let any = false;
    for (const id of [...queued]) {
      if (only !== undefined && id !== only) continue;
      if (!deps.running(id)) {
        queued.delete(id); // stopped meanwhile: it starts on the new version anyway
        any = true;
        continue;
      }
      if (deps.busy(id)) continue;
      any = (await one(id, failed)) || any;
    }
    if (any) deps.changed?.();
  };

  return {
    request,
    retry: () => retry(),
    /** A session's turn ended: restart it if it was waiting for that. */
    turnEnded: (id: string) => (queued.has(id) ? retry(id) : Promise.resolve()),
    queued: (): string[] => [...queued],
  };
}

export type Restarter = ReturnType<typeof createRestarter>;
