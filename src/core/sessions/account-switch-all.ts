import type { SwitchOutcome, SwitchResult } from './account-switch.js';

/**
 * Move every session to one account in one go (asked for: an account ran out, and each session had to be switched
 * by hand). Each goes through the same switch as one session's (account-switch.ts): a live agent restarts on the new
 * account, a working one switches when its turn ends, one that isn't running starts there next time. Archived
 * sessions stay where they are (their Restore decides). One after another: a restart at a time.
 */

export interface SwitchAllSession {
  target: string;
  branch: string;
  account?: string;
  archivedAt?: string;
}

export interface SwitchAllRow {
  id: string;
  /** "api · feat/x". */
  label: string;
  /** How it went (absent: it was refused, `error` says why). */
  outcome?: SwitchOutcome;
  error?: string;
}

/**
 * The sessions a switch of all would move to `to`: not archived, not on it already, and — with `from` — only those
 * on that account. Pure.
 */
export function sessionsToSwitch<T extends SwitchAllSession>(
  sessions: readonly T[],
  accountOf: (s: T) => string,
  to: string,
  from?: string,
): T[] {
  return sessions.filter((s) => !s.archivedAt && accountOf(s) !== to && (from === undefined || accountOf(s) === from));
}

export async function switchAllSessions<T extends SwitchAllSession>(
  deps: {
    sessions: () => readonly T[];
    accountOf: (s: T) => string;
    idOf: (s: T) => string;
    switchAccount: (id: string, to: string) => Promise<SwitchResult>;
  },
  to: string,
  from?: string,
): Promise<SwitchAllRow[]> {
  const rows: SwitchAllRow[] = [];
  for (const s of sessionsToSwitch(deps.sessions(), deps.accountOf, to, from)) {
    const id = deps.idOf(s);
    const label = `${s.target} · ${s.branch}`;
    // One that fails is said and the rest still go.
    const r = await deps.switchAccount(id, to).catch((err: unknown): SwitchResult => ({
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : String(err),
    }));
    rows.push(r.ok ? { id, label, outcome: r.outcome } : { id, label, error: r.error });
  }
  return rows;
}

/** "5 sessions moved to admin: 3 restarted on it, 1 when its turn ends, 1 on its next start; 1 refused". Pure. */
export function switchAllSummary(rows: readonly SwitchAllRow[], to: string): string {
  if (rows.length === 0) return `No session to move: every one is on ${to} already.`;
  const n = (o: SwitchOutcome) => rows.filter((r) => r.outcome === o).length;
  const moved = rows.filter((r) => r.outcome).length;
  const refused = rows.length - moved;
  const parts = [
    n('switched') ? `${n('switched')} restarted on it` : '',
    n('queued') ? `${n('queued')} when its turn ends` : '',
    n('recorded') ? `${n('recorded')} on its next start` : '',
  ].filter(Boolean);
  return (
    `${moved} session${moved === 1 ? '' : 's'} moved to ${to}${parts.length ? `: ${parts.join(', ')}` : ''}` +
    (refused ? `; ${refused} refused` : '')
  );
}
