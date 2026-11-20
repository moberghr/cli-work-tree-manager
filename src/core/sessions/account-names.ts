/**
 * The rules for an account's NAME (Claude's accounts, agents/claude/accounts.ts), apart from its folder's: pure and
 * import-free, so the dashboard's Add account form checks a name as you type by the same rule `work account add` and
 * the server apply (the folder's rules need the file system and stay on the server).
 */

/** The account at the agent's own folder (`~/.claude`): always there, never added or removed. */
export const DEFAULT_ACCOUNT_NAME = 'default';

/** Lower-case letters, digits and dashes, up to 32, not starting with a dash. */
export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Why `name` can't be a new account's name (a reason to show), or null. `taken`: the names there are. */
export function accountNameProblem(name: string, taken: Iterable<string> = []): string | null {
  if (name === DEFAULT_ACCOUNT_NAME) return `“${DEFAULT_ACCOUNT_NAME}” is the account at ~/.claude and can't be reused`;
  if (!ACCOUNT_NAME_RE.test(name)) return `“${name}” is not a valid account name (lower-case letters, digits and dashes, up to 32)`;
  for (const t of taken) if (t === name) return `there is already an account “${name}”`;
  return null;
}
