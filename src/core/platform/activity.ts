import type { ActivityKind, ActivityNote, ActivityRun, ActivitySchedule, ActivityWire } from '../api-types.js';

/**
 * What work is doing in the background, and what it decided: the PR watch,
 * the PR / Jira lists, idle sleep, the Clean up scans. Each job records a
 * run — progress, a note per decision ("archived …", "kept … because …"),
 * a one-line result — and a scheduled job when it runs next or why it is
 * resting. The Activity panel shows it (GET /api/activity).
 *
 * Pure and in memory (no I/O), so the demo keeps one too. Nothing here is
 * state work relies on: it is a window onto decisions made elsewhere.
 */

export interface RunHandle {
  progress(done: number, total: number): void;
  note(text: string, opts?: { level?: ActivityNote['level']; sessionId?: string }): void;
  done(summary: string): void;
  fail(error: string): void;
}

export interface ScheduleHandle {
  next(atMs: number): void;
  pause(untilMs: number, why: string): void;
  resume(): void;
}

export interface ActivityLog {
  start(kind: ActivityKind, label: string): RunHandle;
  /** A run that didn't happen, and why (resting, turned off). Repeats collapse into one row. */
  skip(kind: ActivityKind, label: string, why: string): void;
  schedule(kind: ActivityKind, label: string, everyMs: number): ScheduleHandle;
  snapshot(): ActivityWire;
}

const KEEP_RUNS = 60;
const KEEP_NOTES = 60;

export function createActivityLog(opts: { now?: () => number; onChange?: () => void; keep?: number } = {}): ActivityLog {
  const now = opts.now ?? Date.now;
  const keep = opts.keep ?? KEEP_RUNS;
  const iso = (ms = now()) => new Date(ms).toISOString();
  const changed = () => opts.onChange?.();
  let nextId = 1;
  const running = new Map<number, ActivityRun>();
  let recent: ActivityRun[] = [];
  const schedules = new Map<ActivityKind, ActivitySchedule>();

  const finish = (run: ActivityRun) => {
    running.delete(run.id);
    recent = [run, ...recent].slice(0, keep);
    changed();
  };

  return {
    start(kind, label) {
      const run: ActivityRun = { id: nextId++, kind, label, startedAt: iso(), endedAt: null, status: 'running', progress: null, summary: null, notes: [] };
      running.set(run.id, run);
      changed();
      const open = () => run.status === 'running';
      return {
        progress(done, total) {
          if (!open()) return;
          run.progress = { done, total };
          changed();
        },
        note(text, o = {}) {
          if (!open()) return;
          const n: ActivityNote = { at: iso(), text, level: o.level ?? 'info', ...(o.sessionId ? { sessionId: o.sessionId } : {}) };
          run.notes = [...run.notes, n].slice(-KEEP_NOTES);
          changed();
        },
        done(summary) {
          if (!open()) return;
          Object.assign(run, { status: 'done', endedAt: iso(), summary });
          finish(run);
        },
        fail(error) {
          if (!open()) return;
          Object.assign(run, { status: 'failed', endedAt: iso(), summary: error });
          finish(run);
        },
      };
    },
    skip(kind, label, why) {
      const last = recent[0];
      if (last && last.kind === kind && last.status === 'skipped' && last.summary === why) {
        last.repeats = (last.repeats ?? 0) + 1;
        last.endedAt = iso();
        changed();
        return;
      }
      const at = iso();
      finish({ id: nextId++, kind, label, startedAt: at, endedAt: at, status: 'skipped', progress: null, summary: why, notes: [] });
    },
    schedule(kind, label, everyMs) {
      const s: ActivitySchedule = { kind, label, everyMs, nextAt: null, pausedUntil: null, pausedWhy: null };
      schedules.set(kind, s);
      changed();
      return {
        next(atMs) {
          s.nextAt = iso(atMs);
          changed();
        },
        pause(untilMs, why) {
          Object.assign(s, { pausedUntil: iso(untilMs), pausedWhy: why });
          changed();
        },
        resume() {
          if (!s.pausedUntil) return;
          Object.assign(s, { pausedUntil: null, pausedWhy: null });
          changed();
        },
      };
    },
    snapshot() {
      const copy = <T>(x: T): T => structuredClone(x);
      return {
        running: [...running.values()].map(copy),
        recent: recent.map(copy),
        schedules: [...schedules.values()].map(copy),
      };
    },
  };
}
