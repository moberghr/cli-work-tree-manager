import fs from 'node:fs';
import path from 'node:path';
import { AccountAdminError, type AgentAccounts } from '../agents/types.js';
import { getConfigDir } from '../platform/config.js';
import { hasEnvDelta } from '../platform/env-delta.js';
import type { SpawnSpec } from './pty-host-protocol.js';

/**
 * The dashboard's login terminal for an account (the Accounts page's Add / Log in): the agent's own CLI on that account
 * (`admin.loginLaunch`, what `work account add` runs in your terminal), started in the PTY host under
 * `accountLoginId(name)` (account-login-id.ts) so the page can show it. A new conversation every time (`fresh`): there is
 * nothing to resume, and it runs in a folder of its own, never a worktree. Never restored by a host restart
 * (pty-registry.ts), and stopped when its panel closes. The agent starts in its own permission mode, as every start.
 */

/** Where the login terminal runs: a folder of work's own (an agent may ask once whether to trust it). */
export const accountLoginDir = (): string => path.join(getConfigDir(), 'account-login');

/** The host's spawn spec for an account's login terminal. Throws an AccountAdminError for an account work can't log in to. */
export function accountLoginSpec(
  name: string,
  accounts: Pick<AgentAccounts, 'has' | 'admin'> | undefined,
  dir: string = accountLoginDir(),
): SpawnSpec {
  if (!accounts?.admin) throw new AccountAdminError('its accounts are not managed by work');
  if (!accounts.has(name)) throw new AccountAdminError(`no account “${name}”`);
  const { tool, agentEnv } = accounts.admin.loginLaunch(name);
  fs.mkdirSync(dir, { recursive: true });
  return { cwd: dir, tool, fresh: true, ...(hasEnvDelta(agentEnv) ? { agentEnv } : {}) };
}
