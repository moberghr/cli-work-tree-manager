import fs from 'node:fs';
import { findOnPath } from '../platform/find-on-path.js';
import type { PtyInfo } from './pty-host-protocol.js';
import { LATER_TEXT, restartCountsText } from './restart-view.js';

/**
 * Restarting the agents in the PTY host — after their tool updated (Claude Code
 * replaced its binary; a running Claude keeps the old one until it starts again),
 * or when asked. A restart is its agent stopped and started again in place,
 * resuming its conversation; never in the middle of a turn: a session working or
 * waiting on you restarts when its turn ends.
 */

/** Before this, an mtime isn't when the file was installed: npm unpacks every file dated 1985-10-26. */
const PACKED_MTIME_BEFORE = Date.parse('1990-01-01T00:00:00Z');

/**
 * When the file a tool's command runs was installed, following links
 * (`~/.local/bin/claude` → `versions/2.1.296`): the later of its modification time
 * and its creation — an updater that copies the new file keeping its build date
 * still creates it now. A file npm unpacked with its fixed old date, on a system
 * that doesn't record creation, falls back to its change time (the unpacking).
 * Not the change time otherwise: a chmod or a relink moves it, and every running
 * agent would read as outdated. Null when it isn't on PATH.
 */
export function installedAt(cmd: string, find: (cmd: string) => string | null = findOnPath): number | null {
  const file = find(cmd);
  if (!file) return null;
  try {
    return installTime(fs.statSync(fs.realpathSync(file)));
  } catch {
    return null;
  }
}

/** installedAt's rule on a file's times. Pure. */
export function installTime(st: { mtimeMs: number; ctimeMs: number; birthtimeMs: number }): number {
  const real = (ms: number) => (ms >= PACKED_MTIME_BEFORE ? ms : null);
  const known = [real(st.mtimeMs), real(st.birthtimeMs)].filter((x): x is number => x !== null);
  return known.length ? Math.max(...known) : st.ctimeMs;
}

/**
 * `installedAt` per tool, read again only after `ttlMs`: a lookup walks PATH with a
 * stat per folder and extension, synchronously, and the dashboard asks every few
 * minutes per window.
 */
export function installedAtCache(ttlMs = 60_000, look: (cmd: string) => number | null = installedAt, now: () => number = Date.now) {
  const cache = new Map<string, { at: number | null; read: number }>();
  return (cmd: string): number | null => {
    const hit = cache.get(cmd);
    if (hit && now() - hit.read < ttlMs) return hit.at;
    const at = look(cmd);
    cache.set(cmd, { at, read: now() });
    return at;
  };
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
 * At work, for a restart: what the agent itself says (Claude Code's own state for its process: mid-turn, or
 * waiting on you; at a permission dialog it prints nothing, so only this tells), or its status (the hooks' as
 * the dashboard reads it, corrected by the transcript and decayed) is working or waiting on you, or its
 * terminal printed in the last few seconds, which catches a turn both missed. An agent that says nothing and
 * has no status (a tool with no hooks or process state) has only the last: one silent at a prompt of its own
 * can't be told from idle. Pure.
 */
export function busyForRestart(
  state: 'working' | 'needs_input' | 'idle' | null,
  lastOutputMs: number | null,
  now = Date.now(),
  live: 'busy' | 'idle' | 'waiting' | null = null,
): boolean {
  if (live === 'busy' || live === 'waiting') return true;
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
  /** Restart its agent in place (the host keeps attached terminals); a string: how it went instead (an older host). */
  restart: (id: string) => Promise<string | void>;
  /** Working, or waiting on you: not now. `turnEnded`: its turn just ended (the Stop), so the final message it
   *  printed a moment ago isn't work going on. */
  busy: (id: string, opts?: { turnEnded?: boolean }) => boolean;
  /** Its agent runs in the host (a queued one stopped meanwhile needs nothing). */
  running: (id: string) => boolean;
  /** What one request (or one turn's end) decided, at once: one Activity run, not one per session. */
  report?: (notes: RestartNote[]) => void;
  /** When the waiting ones are looked at next (the Activity panel's schedule); null when nothing waits. */
  scheduled?: (nextAt: number | null) => void;
  changed?: () => void;
  /** A look again a little later (default setTimeout, unref'd): a turn-end the status hasn't caught up with yet. */
  later?: (fn: () => void, ms: number) => void;
}

export interface RestartNote {
  id: string;
  text: string;
  level: 'action' | 'info' | 'warn';
}

type OneRestart = { ok: true; how: string } | { ok: false; error: string };

export interface RestartOutcome {
  now: string[];
  later: string[];
  failed: Array<{ id: string; error: string }>;
}

/** One request's decisions in a line, for its Activity run (restart-view.ts's wording). Pure. */
export function restartNotesSummary(notes: readonly RestartNote[]): string {
  const n = (level: RestartNote['level']) => notes.filter((x) => x.level === level).length;
  return restartCountsText({ restarted: n('action'), later: n('info'), failed: n('warn') });
}

/** While anything waits, how often it is looked at again: a turn whose end no hook reported, or a terminal that was
 *  only redrawing (the printing check) — never left for the 5-minute sweep, which `--dev` and lean don't run. */
export const QUEUE_RECHECK_MS = 15_000;
/** After a turn ends, how long before its agent is restarted: the Stop's own hooks (`work hook turn-end`: the
 *  checkpoint, the status) run as its children, and stopping it at once would kill them mid-way. */
export const TURN_END_GRACE_MS = 10_000;

/**
 * Restarts now what can go now, and the rest when their turn ends (`turnEnded`,
 * from the status hook — and once more a little later, should the status still
 * say working then) or on a later `retry` (a turn whose end no hook reported).
 * One restart per session at a time: asked again meanwhile, it shares that one's
 * outcome.
 */
export function createRestarter(deps: RestarterDeps) {
  const queued = new Set<string>();
  const inFlight = new Map<string, Promise<OneRestart>>();
  const later = deps.later ?? ((fn: () => void, ms: number) => void setTimeout(fn, ms).unref?.());

  /** Restart one: how it went (a different way, on an older host), or why not. */
  const one = (id: string): Promise<OneRestart> => {
    const running = inFlight.get(id);
    if (running) return running;
    queued.delete(id);
    const p = deps.restart(id).then(
      (how): OneRestart => ({ ok: true, how: how || 'restarted its agent (its conversation goes on)' }),
      (err: Error): OneRestart => ({ ok: false, error: err.message }),
    );
    inFlight.set(id, p);
    void p.finally(() => inFlight.delete(id));
    return p;
  };

  /** Restart these, RESTART_AT_ONCE at a time; each waits for its old process to exit. */
  const run = async (ids: string[], notes: RestartNote[]) => {
    const failed: RestartOutcome['failed'] = [];
    const ok = new Set<string>();
    const queue = [...ids];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const r = await one(id);
        if (r.ok) {
          ok.add(id);
          notes.push({ id, text: r.how, level: 'action' });
        } else {
          failed.push({ id, error: r.error });
          notes.push({ id, text: `couldn't restart its agent: ${r.error}`, level: 'warn' });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RESTART_AT_ONCE, queue.length) }, worker));
    return { done: ids.filter((id) => ok.has(id)), failed };
  };

  const finish = (notes: RestartNote[]) => {
    if (!notes.length) return;
    deps.report?.(notes);
    deps.changed?.();
  };

  /** Restart these (the caller found them running in the host: its list is fresh, `running` is a cache). */
  const request = async (ids: readonly string[]): Promise<RestartOutcome> => {
    const plan = restartPlan(ids, (id) => deps.busy(id));
    const notes: RestartNote[] = [];
    for (const id of plan.later) {
      queued.add(id);
      notes.push({ id, text: `${LATER_TEXT} (it is working or waiting on you)`, level: 'info' });
    }
    const { done, failed } = await run(plan.now, notes);
    finish(notes);
    tick();
    return { now: done, later: plan.later, failed };
  };

  // While anything waits, it is looked at again every QUEUE_RECHECK_MS.
  let ticking = false;
  const tick = () => {
    if (ticking) return;
    if (queued.size === 0) {
      deps.scheduled?.(null);
      return;
    }
    ticking = true;
    deps.scheduled?.(Date.now() + QUEUE_RECHECK_MS);
    later(() => {
      ticking = false;
      void retry()
        .catch(() => {})
        .finally(tick);
    }, QUEUE_RECHECK_MS);
  };

  /** Restart the queued ones (or `only`) that can go now; a queued one stopped meanwhile is dropped. */
  const retry = async (only?: string, opts?: { turnEnded?: boolean }): Promise<void> => {
    const notes: RestartNote[] = [];
    const ready: string[] = [];
    for (const id of [...queued]) {
      if (only !== undefined && id !== only) continue;
      if (!deps.running(id)) {
        queued.delete(id);
        notes.push({ id, text: 'no longer waits to restart: it was stopped meanwhile (it starts on the new version)', level: 'info' });
        continue;
      }
      if (!deps.busy(id, opts)) ready.push(id);
    }
    await run(ready, notes);
    finish(notes);
  };

  return {
    request,
    retry: () => retry(),
    /** A session's turn ended: restart it if it was waiting for that — and if it still reads as busy, look again shortly. */
    turnEnded: (id: string): void => {
      if (!queued.has(id)) return;
      later(() => void retry(id, { turnEnded: true }).catch(() => {}), TURN_END_GRACE_MS);
    },
    queued: (): string[] => [...queued],
    /** Being restarted now (the host lists them as exited meanwhile: still this session's). */
    restarting: (): string[] => [...inFlight.keys()],
  };
}

export type Restarter = ReturnType<typeof createRestarter>;
