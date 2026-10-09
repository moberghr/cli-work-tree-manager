/**
 * Ticket hints (config `time.hints`, the timesheet tool's TICKET_HINTS): a
 * workstream whose name doesn't carry its Jira key — a worktree named
 * `tmp-vendor-analysis` that is OPS-2222 "Payment reconciliation" — gets its
 * ticket from the words you list. A hint marked `placeholder` is a ticket
 * still to be created in Jira: the day shows it, and it can't be posted
 * until it exists. Pure (the server, the demo and the SPA share it).
 */

export interface TicketHint {
  /** Text that means this ticket (case doesn't matter; at least three characters). */
  matches: string[];
  /** What it is, for the tab and the AI step when Jira has no title. */
  summary?: string;
  /** Not in Jira yet: create it before posting. */
  placeholder?: true;
}

/** The ticket the first hint whose words appear in the texts names, or null. */
export function hintKey(texts: ReadonlyArray<string | undefined>, hints: Readonly<Record<string, TicketHint>> | undefined): string | null {
  if (!hints) return null;
  const hay = texts
    .filter((t): t is string => !!t)
    .join('\n')
    .toLowerCase();
  if (!hay) return null;
  for (const [key, h] of Object.entries(hints)) if (h.matches.some((m) => hay.includes(m.toLowerCase()))) return key;
  return null;
}

/** The keys of these rows that are placeholders (to create in Jira first). */
export function placeholderKeys(keys: readonly string[], hints: Readonly<Record<string, TicketHint>> | undefined): string[] {
  return keys.filter((k) => hints?.[k]?.placeholder);
}
