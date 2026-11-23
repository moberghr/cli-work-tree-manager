import type { SessionAttention } from '../api-types.js';
import { STALE_WORKING_MS } from '../status/session-status.js';
import { PROGRESS_INDETERMINATE, PROGRESS_SET, type ProgramKind, type StreamSignal } from './stream-status.js';

/**
 * A status for a session whose tool isn't Claude Code (config `aiCommand`, e.g. opencode, codex): no hooks report its
 * turns, so its terminal stands in. First what the agent says about itself in its output (`statusFromSignal`: OSC 7501
 * program status, else an OSC 9;4 bar), then the PTY host's "last printed anything" — a working agent redraws its
 * spinner, an idle one prints nothing: working while it printed in the last `OUTPUT_WORKING_MS`, idle after, never
 * "done, unseen" or "needs input" (output can't tell a finished turn from a question). Hooks beat both: this is only
 * asked when no hook status exists (session-wire.ts). Pure.
 */

export const OUTPUT_WORKING_MS = 10_000;

export interface PtyOutput {
  /** The tool's binary (the host's spawn spec). */
  tool?: string;
  /** When it last printed (ISO). */
  lastOutputAt?: string;
  startedAt: string;
  /** What it says about itself in its output (PtyInfo.signal). */
  signal?: StreamSignal;
}

export function statusFromOutput(p: PtyOutput, now: number): SessionAttention | null {
  if (!p.tool || p.tool === 'claude') return null;
  const said = p.signal ? statusFromSignal(p.signal, p.tool, p.lastOutputAt, now) : null;
  if (said) return said;
  if (!p.lastOutputAt) return null;
  const at = Date.parse(p.lastOutputAt);
  if (!Number.isFinite(at)) return null;
  const working = now - at < OUTPUT_WORKING_MS;
  return {
    state: working ? 'working' : 'idle',
    seen: true,
    since: p.lastOutputAt,
    updatedAt: p.lastOutputAt,
    stale: false,
    summary: `${working ? 'Printing' : 'Quiet'} — from its terminal output (${p.tool} has no status hooks)`,
  };
}

const WAITING_FOR: Record<ProgramKind, string> = { permission: 'your permission', question: 'your answer', auth: 'you to sign in' };

/**
 * What the agent said in-band, as a status; null where it says nothing that decides one (no signal, a cleared one, a
 * bar in error or paused), and the output guess decides.
 *
 * - OSC 7501: working → working; blocked → needs input (its `msg` as the summary); idle, done and error → idle, seen.
 *   `done` is "finished, not seen yet", but nothing here could mark it seen (no status row: `markSeen`), and the agent
 *   itself turns it into idle at your next key — so it is shown as idle, its summary saying it finished.
 * - OSC 9;4: a bar with a percent (1) or indeterminate (3) → working. 2 (error) and 4 (paused) don't say whether it is
 *   still at work; 0 is no bar.
 *
 * A "working" never outlives `STALE_WORKING_MS` of silence: an agent at work redraws something (Codex its elapsed
 * time, Claude Code and opencode a spinner), so a terminal that said working and then printed nothing for 15 minutes
 * went away without saying (killed, crashed under a shell that lives on). It is shown idle and `stale`, as a hook's
 * working is after the same quiet (session-status.ts). The spec forbids requiring a heartbeat; this asks none — any
 * output at all keeps it. Blocked has no expiry: waiting on you is quiet by nature, and a new process (a new mirror)
 * or the agent's next report ends it.
 */
export function statusFromSignal(
  signal: StreamSignal,
  tool: string,
  lastOutputAt: string | undefined,
  now: number,
): SessionAttention | null {
  const by = `${tool} says so in its terminal`;
  const program = signal.program;
  if (program) {
    const percent = program.progress !== undefined ? `, ${program.progress}%` : '';
    const base = {
      since: program.since,
      updatedAt: lastOutputAt ?? program.since,
      ...(program.progress !== undefined ? { progress: program.progress } : {}),
    };
    switch (program.state) {
      case 'working':
        return working(base, lastOutputAt, now, `Working${percent}`, by);
      case 'blocked':
        return {
          ...base,
          state: 'needs_input',
          seen: false,
          stale: false,
          summary: program.message ?? `Waiting for ${program.kind ? WAITING_FOR[program.kind] : 'you'}${percent} — ${by}`,
        };
      case 'done':
        return { ...base, state: 'idle', seen: true, stale: false, summary: program.message ?? `Finished — ${by}` };
      case 'error':
        return { ...base, state: 'idle', seen: true, stale: false, summary: program.message ?? `Stopped on an error — ${by}` };
      case 'idle':
        return { ...base, state: 'idle', seen: true, stale: false, summary: `Idle — ${by}` };
      default:
        return null; // a newer host's state this build doesn't know: the guess decides
    }
  }
  const bar = signal.progress;
  if (bar && (bar.state === PROGRESS_SET || bar.state === PROGRESS_INDETERMINATE)) {
    const set = bar.state === PROGRESS_SET;
    const base = { since: bar.since, updatedAt: lastOutputAt ?? bar.since, ...(set ? { progress: bar.percent } : {}) };
    return working(base, lastOutputAt, now, `Busy${set ? `, ${bar.percent}%` : ''}`, `its progress bar (${tool})`);
  }
  return null;
}

function working(
  base: Pick<SessionAttention, 'since' | 'updatedAt' | 'progress'>,
  lastOutputAt: string | undefined,
  now: number,
  what: string,
  by: string,
): SessionAttention {
  const last = Date.parse(lastOutputAt ?? base.since);
  if (Number.isFinite(last) && now - last > STALE_WORKING_MS) {
    const quiet = `${Math.round(STALE_WORKING_MS / 60_000)} min`;
    return { ...base, state: 'idle', seen: true, stale: true, summary: `Said it was working, then printed nothing for ${quiet} — ${by}` };
  }
  return { ...base, state: 'working', seen: true, stale: false, summary: `${what} — ${by}` };
}
