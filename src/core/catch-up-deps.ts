import { runInternal } from './checkpoint-summary.js';
import type { CatchUpFacts } from './catch-up.js';
import { readStatus } from './session-status.js';

/** "Catch me up"'s real inputs (catch-up.ts), shared by the route, `work catchup` and `work fork`. */

/** The internal agent run that writes them (no tools). */
export const askCatchUp = (prompt: string) => runInternal(prompt, 90_000);

/** What the summary may say besides the conversation: its status, plus what the caller adds (the uncommitted size). */
export function catchUpFacts(id: string, extra: CatchUpFacts = {}): CatchUpFacts {
  const st = readStatus(id);
  return { ...(st ? { status: `${st.state}${st.summary ? ` (${st.summary})` : ''}` } : {}), ...extra };
}
