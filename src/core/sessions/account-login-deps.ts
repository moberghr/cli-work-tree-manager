import { agentFor } from '../agents/index.js';
import type { ActivityLog } from '../platform/activity.js';
import { loadConfig } from '../platform/config.js';
import { startAccountLogin, stopAccountLogin } from '../pty/pty-pool.js';
import { accountSkillsNote, createAccountLogins, type AccountLogins } from './account-admin.js';
import { accountSkillsInChild } from './account-skills-child.js';

/**
 * The real I/O behind the Accounts page's login terminals: the configured agent's accounts, the PTY host (pty-pool.ts),
 * and work's skills put into a new account's folder in a child (`work account skills <name>`), noted in Activity.
 */
export function defaultAccountLogins(o: { activity: Pick<ActivityLog, 'start'>; workBin: () => string }): AccountLogins {
  return createAccountLogins({
    has: (name) => agentFor(loadConfig()).accounts?.has(name) ?? false,
    start: startAccountLogin,
    stop: stopAccountLogin,
    installSkills: accountSkillsInChild(o.workBin),
    note: accountSkillsNote(o.activity),
  });
}
