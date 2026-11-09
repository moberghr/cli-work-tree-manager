import type { PtyInfo } from './pty-host-protocol.js';

/**
 * Which session Claudes to put to sleep: stop them in the PTY host so they
 * stop holding memory (a few hundred MB each; a dozen once ran the machine
 * out). Opening the session later starts it again with its conversation
 * (--continue), as after a restart. Pure: the caller lists and stops.
 *
 * Asleep only when ALL of these hold:
 *  - nothing is attached: no dashboard Terminal tab, no `work attach`
 *    (a host from before `clients` was reported: never);
 *  - it has printed nothing for `afterMs` — an idle Claude at its prompt
 *    prints nothing, a working one keeps redrawing its spinner;
 *  - its status isn't working or waiting for an answer;
 *  - and nothing of it is still at work (`stillAtWork`). The Ctrl+K assistant
 *    sleeps by the same rules (its panel open is a terminal attached).
 */
/**
 * Ten minutes: a Claude holds a few hundred MB, more with its language
 * server, and opening its session resumes it in a few seconds (`--continue`;
 * the prompt cache is Anthropic's, not the process's). What goes with it:
 * anything it started in the background (a dev server, a watcher).
 */
export const DEFAULT_SLEEP_AFTER_MINUTES = 10;

/**
 * The shortest sleep. The Terminal tab reads a Stop within the last 30
 * minutes, with no PTY, as "Claude runs in another terminal" and won't
 * start it again (ELSEWHERE_IDLE_MS, terminal-ws.ts) — which held this at 30,
 * until a sleep recorded that work stopped it (`markAgentStopped`): signs
 * from before that are the slept Claude's, and the tab starts it again.
 */
export const MIN_SLEEP_AFTER_MINUTES = 5;

/** `sleepIdleAfterMinutes` as milliseconds: 0 = never, else at least the minimum. */
export function sleepAfterMs(minutes: number): number {
  return minutes <= 0 ? 0 : Math.max(minutes, MIN_SLEEP_AFTER_MINUTES) * 60_000;
}

export function sleepCandidates(
  ptys: readonly PtyInfo[],
  now: number,
  afterMs: number,
  busy: (id: string) => boolean,
  keep: ReadonlySet<string> = new Set(),
): string[] {
  if (afterMs <= 0) return [];
  return ptys
    .filter((p) => {
      if (p.exited || keep.has(p.id)) return false;
      if (p.clients === undefined || p.clients > 0) return false;
      const last = p.lastOutputAt ? Date.parse(p.lastOutputAt) : NaN;
      if (!Number.isFinite(last) || now - last < afterMs) return false;
      return !busy(p.id);
    })
    .map((p) => p.id);
}

/**
 * What idle sleep asks before it stops a Claude that `sleepCandidates` let
 * through (nothing attached, quiet long enough): whatever might still be at
 * work. Each is the I/O's; `stillAtWork` decides.
 */
export interface SleepChecks {
  /** The status the dashboard shows (transcript activity after a missed hook reads as working). */
  shown: (id: string) => 'working' | 'needs_input' | 'idle' | null;
  /** Claude Code's own state for the PTY's process: busy while a background agent it started runs, waiting at a dialog. */
  live: (id: string, pid: number) => 'busy' | 'idle' | 'waiting' | null;
  /** Background commands (a build, tests, a dev server) its conversation started since `sinceMs` and that haven't ended. */
  backgroundCommands: (id: string, sinceMs: number) => number;
  /** What runs from its folders (a dev server, a watcher), named; [] for nothing. Throws when it can't tell. */
  runningFrom: (id: string) => Promise<string[]>;
}

/**
 * Why a quiet Claude must stay awake, or null when it may sleep. Idle means
 * idle: not working (a background agent it started included), not waiting
 * on you, no background command of its still running, nothing running from
 * its folders — stopping a Claude stops what it started. When a check can't
 * tell (it throws), it stays awake: a Claude kept costs memory, one stopped
 * mid-work costs the work.
 */
export async function stillAtWork(p: Pick<PtyInfo, 'id' | 'pid' | 'startedAt'>, c: SleepChecks): Promise<string | null> {
  try {
    const shown = c.shown(p.id);
    if (shown === 'working') return 'its Claude is working';
    if (shown === 'needs_input') return 'it waits for your answer';
    const live = c.live(p.id, p.pid);
    if (live === 'busy') return 'Claude Code says it is busy (a background agent it started, perhaps)';
    if (live === 'waiting') return 'Claude Code says it is waiting at a dialog';
    const open = c.backgroundCommands(p.id, Date.parse(p.startedAt) || 0);
    if (open > 0) return `${open} background command${open === 1 ? '' : 's'} it started ${open === 1 ? 'is' : 'are'} still running`;
    const running = await c.runningFrom(p.id);
    if (running.length)
      return `still running from its folder: ${running.slice(0, 2).join(', ')}${running.length > 2 ? ` and ${running.length - 2} more` : ''}`;
    return null;
  } catch (err) {
    return `couldn't tell whether it is still at work (${(err as Error).message})`;
  }
}

/** The candidates that may sleep, and why each other one stays awake. */
export async function sleepPlan(
  candidates: readonly Pick<PtyInfo, 'id' | 'pid' | 'startedAt'>[],
  c: SleepChecks,
): Promise<{ sleep: string[]; awake: Array<{ id: string; why: string }> }> {
  const sleep: string[] = [];
  const awake: Array<{ id: string; why: string }> = [];
  for (const p of candidates) {
    const why = await stillAtWork(p, c);
    if (why) awake.push({ id: p.id, why });
    else sleep.push(p.id);
  }
  return { sleep, awake };
}
