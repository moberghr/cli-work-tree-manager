/**
 * The PTY-host id of an account's login terminal (the Accounts page's Log in): the agent's own CLI on that account,
 * started in the host so the dashboard can show it, never restored by a host restart. Pure and import-free: the PTY
 * registry, the pool and the dashboard all name it the same way.
 */

export const ACCOUNT_LOGIN_PREFIX = 'account-login:';

/** The login terminal's id for an account. */
export const accountLoginId = (name: string): string => `${ACCOUNT_LOGIN_PREFIX}${name}`;

/** The account a login terminal's id is for; null for any other id (a session's, the assistant's). */
export function accountOfLoginId(id: string): string | null {
  return id.startsWith(ACCOUNT_LOGIN_PREFIX) && id.length > ACCOUNT_LOGIN_PREFIX.length ? id.slice(ACCOUNT_LOGIN_PREFIX.length) : null;
}

/** It is a login terminal (no session, never restored). */
export const isAccountLoginId = (id: string): boolean => accountOfLoginId(id) !== null;
