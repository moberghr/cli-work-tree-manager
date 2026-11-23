import type { AgentState } from '../status/attention.js';
import type { LiveAgent } from '../agents/types.js';

/**
 * What happens to a note just posted to a session (a comment, `work send`, a child's `work report`): typed into its
 * agent now (`typed`: work types one short line, NOTE_NUDGE, and the prompt hook attaches the note), left for the end
 * of the turn it is in (`next-turn`: the Stop hook hands it over), or null — no terminal of work's runs it, so the
 * prompt hook hands it over whenever its next turn starts.
 *
 * "Is it mid-turn" is asked of the agent itself first: Claude Code's own state file for the Claude work's PTY host
 * runs. The hooks' record alone was wrong after any turn that ended without a Stop hook — an interrupt (Esc) most
 * often — and stayed "working": a note sent to that idle Claude waited for a turn end that never came (reported:
 * one session's `work send` to an idle one never arrived). The record (as the dashboard shows it, so a stale
 * "working" decays) decides only when the agent says nothing.
 *
 * Waiting on you (a permission prompt, a dialog) is not typed into: Enter there would answer it. The turn goes on
 * once you do, and its end hands the note over.
 */
export type NoteDelivery = 'typed' | 'next-turn' | null;

export function noteDelivery(o: {
  author: string;
  /** Its agent runs in work's PTY host. */
  hosted: boolean;
  /** Notes waiting for it (none: nothing to deliver). */
  pending: number;
  /** What the host's agents for it say of themselves (null: they say nothing). */
  live: Array<LiveAgent['state']>;
  /** Its status as the dashboard shows it (null: none recorded). */
  shown: AgentState | null;
}): NoteDelivery {
  // Claude's own replies aren't for Claude.
  if (o.author !== 'user' || !o.hosted || o.pending === 0) return null;
  const said = o.live.filter((s): s is NonNullable<LiveAgent['state']> => s !== null);
  if (said.length) return said.some((s) => s === 'busy' || s === 'waiting') ? 'next-turn' : 'typed';
  // Waiting on you is never typed into, whichever source says so: Enter there would answer it.
  return o.shown === 'working' || o.shown === 'needs_input' ? 'next-turn' : 'typed';
}

/** When a note left for the end of a turn is looked at again (ms after it was posted): in case that end never fires. */
export const RECHECK_AFTER_MS: readonly number[] = [20_000, 90_000, 300_000];
