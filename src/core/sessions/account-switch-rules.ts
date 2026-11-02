/**
 * When a switch of account is refused before anything is stopped or moved — the rules the real switch
 * (account-switch.ts) and the demo's (server/demo/demo-accounts.ts) share. Pure: no imports.
 */

/** An account as the rules see it (agents/types.ts `AccountInfo`; the wire's `AccountWire`). */
export interface SwitchAccountInfo {
  name: string;
  /** Logged in; null: can't tell (macOS keeps Claude's credentials in the keychain) — allowed. */
  loggedIn: boolean | null;
}

export interface SwitchFacts {
  /** Archived, or being archived right now. */
  archived: boolean;
  /** Its agent's accounts and the one it is on; null: its agent has none. */
  accounts: { list: readonly SwitchAccountInfo[]; current: string } | null;
  /** Where a switch already waiting for its turn (or being done now) goes; null: none. */
  pendingTo: string | null;
  /** Its agent runs in the PTY host (a switch can stop and start it there). */
  inHost: boolean;
  /** Its agent runs in a terminal outside work. */
  runningOutside: boolean;
}

export type SwitchRefusal = { status: 400 | 409; error: string };

/** Why the session can't be moved to `to` (status and reason), or null. In the order the user is told them. */
export function switchRefusal(to: string, f: SwitchFacts): SwitchRefusal | null {
  if (f.archived) return { status: 409, error: 'it is archived: restore it first' };
  if (!f.accounts) return { status: 409, error: "its agent doesn't have accounts" };
  const target = f.accounts.list.find((a) => a.name === to);
  if (!target) return { status: 400, error: `no account “${to}” (see \`work account list\`)` };
  if (target.loggedIn === false)
    return { status: 409, error: `nobody is logged in on “${to}”: run \`work account add ${to}\` again to log in, or /login on it` };
  if (f.pendingTo !== null)
    return { status: 409, error: `a switch is already waiting for its turn to end (to ${f.pendingTo || 'another account'})` };
  if (f.accounts.current === to) return { status: 409, error: `it already runs on “${to}”` };
  if (!f.inHost && f.runningOutside)
    return {
      status: 409,
      error: 'its Claude runs in a terminal outside work: stop it there first (its conversation would be moved from under it)',
    };
  return null;
}
