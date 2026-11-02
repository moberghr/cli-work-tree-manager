import type { AccountsWire, AccountSwitchWire, AccountWire } from '../../../core/api-types.js';
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

/** "Claude account…" is offered for a live session of an agent with accounts, once there is more than one to pick from. */
export function canSwitchAccount(s: Pick<SessionSummary, 'agent' | 'archivedAt'>, multiple: boolean): boolean {
  return multiple && !s.archivedAt && hasAccounts(s);
}

/** The account a session runs on now. */
export const currentAccount = (s: Pick<SessionSummary, 'account'>): string => s.account ?? DEFAULT_ACCOUNT;

/** One row of the dialog: whether it can be picked, and what to say beside it. */
export function accountRow(a: AccountWire, current: string): { disabled: boolean; hint: string } {
  if (a.name === current) return { disabled: true, hint: 'current' };
  if (a.loggedIn === false) return { disabled: true, hint: `not logged in: run work account add ${a.name}, or log in first` };
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

/** What ⇧C says when there is no Claude account… to open: the accounts couldn't be read (and why), or there is only one. */
export function noSwitchText(loadError: string | null): string {
  return loadError
    ? `Couldn't load the Claude accounts: ${loadError}`
    : 'Only one Claude account is set up: add another with `work account add <name>`';
}

/** The New worktree's "More options" label part, and the rail tooltip's: only an account that isn't the default says anything. */
export const accountLabel = (account: string | undefined): string => (account && account !== DEFAULT_ACCOUNT ? `account ${account}` : '');

/** Claude account… is offered (menus, the header) only once there is more than one account to pick from. */
export const hasMultipleAccounts = (w: Pick<AccountsWire, 'accounts'> | null | undefined): boolean => (w?.accounts.length ?? 0) > 1;

/** What Claude account… (a menu, the header, ⇧C) does for a session: open the dialog, or say in a toast why not. */
export type AccountAction = { kind: 'open' } | { kind: 'toast'; text: string };

export function accountAction(
  s: Pick<SessionSummary, 'agent' | 'archivedAt'>,
  o: { multiple: boolean; loadError: string | null },
): AccountAction {
  if (!o.multiple) return { kind: 'toast', text: noSwitchText(o.loadError) };
  if (!canSwitchAccount(s, true)) return { kind: 'toast', text: 'Only a live session of an agent with accounts can change its account' };
  return { kind: 'open' };
}

/** The toast after the dialog cancelled a switch waiting for its turn. */
export const cancelledText = (to: string): string => `It stays on its account: the switch to ${to} is cancelled`;
