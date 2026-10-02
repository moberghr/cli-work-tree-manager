import type { SessionAttention } from './api-types.js';

/**
 * A status for a session whose tool isn't Claude Code (config `aiCommand`,
 * e.g. opencode): no hooks report its turns, so the PTY host's "last printed
 * anything" stands in — a working agent redraws its spinner, an idle one
 * prints nothing. Working while it printed in the last `OUTPUT_WORKING_MS`,
 * idle after; never "done, unseen" or "needs input" (output can't tell a
 * finished turn from a question). Pure.
 */

export const OUTPUT_WORKING_MS = 10_000;

export interface PtyOutput {
  /** The tool's binary (the host's spawn spec). */
  tool?: string;
  /** When it last printed (ISO). */
  lastOutputAt?: string;
  startedAt: string;
}

export function statusFromOutput(p: PtyOutput, now: number): SessionAttention | null {
  if (!p.tool || p.tool === 'claude' || !p.lastOutputAt) return null;
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
