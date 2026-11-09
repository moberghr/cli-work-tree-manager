import type { AccountsWire, AccountSwitchWire, AccountWire } from '../../../core/api-types.js';
import { accountNameProblem } from '../../../core/sessions/account-names.js';
import { usageText } from '../../../core/usage/usage.js';
import type { SessionSummary } from '../api/client.js';
import { agentCan } from './session-display.js';

/**
 * Claude accounts in the dashboard (agents/claude/accounts.ts): which sessions
 * can be moved to another login, how an account reads in the dialog, what a
 * switch's outcome says. Pure.
 */

/** The name a session with no recorded account runs on (the `~/.claude` login). */
export const DEFAULT_ACCOUNT = 'default';

/** Its agent runs on one of several logins (the adapter's `accounts` part, `can.accounts`; no agent on the row: an older server, Claude). */
export const hasAccounts = (s: Pick<SessionSummary, 'agent'>): boolean => agentCan(s, 'accounts');

/** "Claude account…" is offered for a live session of an agent with accounts — with only one account too: its dialog then offers to add another. */
export function canSwitchAccount(s: Pick<SessionSummary, 'agent' | 'archivedAt'>): boolean {
  return !s.archivedAt && hasAccounts(s);
}

/** The account a session runs on now. */
export const currentAccount = (s: Pick<SessionSummary, 'account'>): string => s.account ?? DEFAULT_ACCOUNT;

/** One row of the dialog: whether it can be picked, and what to say beside it. */
export function accountRow(a: AccountWire, current: string): { disabled: boolean; hint: string } {
  if (a.name === current) return { disabled: true, hint: 'current' };
  if (a.loggedIn === false) return { disabled: true, hint: 'not logged in: log in on the Accounts page first' };
  return { disabled: false, hint: '' };
}

/** The login state, in a word. */
export const loginText = (a: AccountWire): string => (a.loggedIn === null ? 'unknown' : a.loggedIn ? 'logged in' : 'not logged in');

/** What a switch's outcome says in the toast. */
export function switchText(outcome: AccountSwitchWire['outcome'], name: string): string {
  if (outcome === 'switched') return `Moved to ${name}`;
  if (outcome === 'queued') return 'Switches after its current turn';
  return `Its next start uses ${name}`;
}

/** An account as a list names it: the one new sessions use marked "(default)" — unless its name already says so. */
export const accountName = (a: { name: string; isDefault: boolean }): string =>
  a.isDefault && a.name !== DEFAULT_ACCOUNT ? `${a.name} (default)` : a.name;

/** A switch waiting for its turn to end, in a few words (the header chip, the dialog). */
export const pendingText = (to: string): string => `→ ${to} after this turn`;

/** The rail tooltip's part for a switch waiting for its turn. */
export const pendingLabel = (to: string | undefined): string => (to ? `moves to account ${to} after this turn` : '');

/** What Claude account… says when there is nothing to move to: the accounts couldn't be read (and why), or there is only one. */
export function noSwitchText(loadError: string | null): string {
  return loadError
    ? `Couldn't load the Claude accounts: ${loadError}`
    : 'Only one Claude account is set up: add another (its own login) to move this session to it.';
}

/** The New worktree's "More options" label part, and the rail tooltip's: only an account that isn't the default says anything. */
export const accountLabel = (account: string | undefined): string => (account && account !== DEFAULT_ACCOUNT ? `account ${account}` : '');

/** More than one account: something to move a session to. */
export const hasMultipleAccounts = (w: Pick<AccountsWire, 'accounts'> | null | undefined): boolean => (w?.accounts.length ?? 0) > 1;

/** What Claude account… (a menu, the header, ⇧C) does for a session: open the dialog, or say in a toast why not. */
export type AccountAction = { kind: 'open' } | { kind: 'toast'; text: string };

export function accountAction(s: Pick<SessionSummary, 'agent' | 'archivedAt'>): AccountAction {
  if (!canSwitchAccount(s)) return { kind: 'toast', text: 'Only a live session of an agent with accounts can change its account' };
  return { kind: 'open' };
}

/** The toast after the dialog cancelled a switch waiting for its turn. */
export const cancelledText = (to: string): string => `It stays on its account: the switch to ${to} is cancelled`;

// ---- the Accounts page ----

/** One account as the Accounts page shows it. */
export interface AccountPageRow {
  name: string;
  /** Its name, the default marked. */
  label: string;
  dir: string;
  isDefault: boolean;
  /** "logged in", "not logged in", "login unknown". */
  login: string;
  /** Not logged in: its Log in is the thing to do. */
  needsLogin: boolean;
  /** Its last usage reading in a line. */
  usage: string;
  /** Who is on it, in a few words. */
  sessions: string;
  /** The sessions on it, live ones first (the tooltip). */
  sessionNames: string[];
  /** Make default is offered (not already the default). */
  canMakeDefault: boolean;
  /** Remove is offered: never the default account (~/.claude), nor while live sessions run on it. */
  canRemove: boolean;
  /** Why Remove isn't offered, when it isn't. */
  removeWhy: string;
}

const plural = (n: number, what: string) => `${n} ${what} session${n === 1 ? '' : 's'}`;

/** Who is on an account in a few words ("2 live sessions · 1 archived session"); unknown from an older server. */
export function sessionsText(a: Pick<AccountWire, 'liveSessions' | 'archivedSessions'>): string {
  if (!a.liveSessions && !a.archivedSessions) return '';
  const live = a.liveSessions?.length ?? 0;
  const archived = a.archivedSessions?.length ?? 0;
  if (!live && !archived) return 'no sessions';
  return [live ? plural(live, 'live') : '', archived ? plural(archived, 'archived') : ''].filter(Boolean).join(' · ');
}

/** The page's rows: the default account (~/.claude) first, as the server lists them. */
export function accountPageRows(w: AccountsWire, now: number): AccountPageRow[] {
  return w.accounts.map((a) => {
    const live = a.liveSessions?.length ?? 0;
    const removeWhy =
      a.name === DEFAULT_ACCOUNT ? 'the account at ~/.claude is always there' : live ? `${plural(live, 'live')} run on it` : '';
    return {
      name: a.name,
      label: accountName(a),
      dir: a.dir,
      isDefault: a.isDefault,
      login: a.loggedIn === null ? 'login unknown' : a.loggedIn ? 'logged in' : 'not logged in',
      needsLogin: a.loggedIn === false,
      usage: a.usage === undefined ? '' : usageText(a.usage, now),
      sessions: sessionsText(a),
      sessionNames: [...(a.liveSessions ?? []), ...(a.archivedSessions ?? []).map((x) => `${x} (archived)`)],
      canMakeDefault: !a.isDefault,
      canRemove: !removeWhy,
      removeWhy,
    };
  });
}

/** Why the Add form's name can't be one (as the server would refuse it), or null. Empty: not said yet. */
export function addAccountProblem(name: string, w: Pick<AccountsWire, 'accounts'> | null): string | null {
  const n = name.trim();
  if (!n) return null;
  return accountNameProblem(
    n,
    (w?.accounts ?? []).map((a) => a.name),
  );
}

/** The folder a new account gets when none is given (the placeholder). */
export const defaultAccountFolder = (name: string): string => `~/.claude-${name.trim() || '<name>'}`;

/** A refused removal, as the page asks about it: archived sessions can be forced past (their Restore starts on the default account), live ones never. */
export function removeRefusal(e: { message: string; sessions: string[]; kind?: 'live' | 'archived' }): { text: string; canForce: boolean } {
  const names = e.sessions.length ? `: ${e.sessions.join(', ')}` : '';
  if (e.kind === 'archived')
    return { text: `${e.message}${names}. Remove it anyway? Their Restore then starts on the default account.`, canForce: true };
  return { text: `${e.message}${names}.`, canForce: false };
}
