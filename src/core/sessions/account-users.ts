import { agentOf, AccountAdminError, type AccountUsers, type AgentAccounts } from '../agents/index.js';
import { loadHistory } from './history.js';
import type { WorktreeSession } from './session-types.js';

/**
 * Which sessions are on an account, and forgetting one (`work account remove`): agent-neutral — a session's account is
 * what its own agent's `accounts` part says (agents/types.ts); a session of an agent without accounts is on none.
 */

const label = (s: WorktreeSession) => `${s.target} · ${s.branch}`;

/** The sessions on `name` of the agent `accounts` belongs to: live ones, and archived ones (a Restore would start one on it). */
export function sessionsOnAccount(
  name: string,
  accounts: Pick<AgentAccounts, 'current'>,
  sessions: readonly WorktreeSession[] = loadHistory(),
): AccountUsers {
  const on = sessions.filter((s) => agentOf(s).accounts === accounts && accounts.current(s) === name);
  return { live: on.filter((s) => !s.archivedAt).map(label), archived: on.filter((s) => s.archivedAt).map(label) };
}

/**
 * Forget an account of an agent. Refused while a live session runs on it, and while archived ones use it unless `force`
 * (their Restore would then start on the default account): the sessions are read under the config's lock, right before
 * the write, so one made meanwhile on it still stops it.
 */
export async function removeAgentAccount(
  accounts: AgentAccounts,
  name: string,
  opts: { force?: boolean; sessions?: () => readonly WorktreeSession[] } = {},
): Promise<void> {
  if (!accounts.admin) throw new AccountAdminError('its accounts are not managed by work');
  await accounts.admin.remove(name, () => {
    const users = sessionsOnAccount(name, accounts, opts.sessions ? opts.sessions() : loadHistory());
    return opts.force ? { live: users.live, archived: [] } : users;
  });
}
