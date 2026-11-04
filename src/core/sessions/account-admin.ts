import { AccountAdminError, type AgentAccountAdmin, type AgentAccounts } from '../agents/index.js';
import type { ActivityLog } from '../platform/activity.js';
import type { UsageAccount } from '../usage/usage.js';
import { sessionsOnAccount } from './account-users.js';
import { loadHistory } from './history.js';
import type { WorktreeSession } from './session-types.js';

/**
 * The accounts of an agent as `work account` and the dashboard's Accounts page both manage them: one overview (who is
 * logged in, its last usage reading, the sessions on it), adding one and choosing the default through the agent's
 * `accounts.admin`, and the login terminals the page opens (start, stop, and work's skills put into a new account's
 * folder once its first login is over). Agent-neutral: everything of the agent's goes through its adapter.
 */

/** One account, with what the page and `work account list` show of it. */
export interface AccountOverview {
  name: string;
  dir: string;
  isDefault: boolean;
  /** Null: can't tell (macOS keeps Claude's credentials in the keychain). */
  loggedIn: boolean | null;
  /** The sessions on it as "target · branch": the live ones, and the archived ones (whose Restore needs it). */
  live: string[];
  archived: string[];
  /** Its last usage reading (as recorded: a window past its reset is aged by whoever shows it); null: none yet. */
  usage: UsageAccount | null;
}

export function accountOverview(
  accounts: AgentAccounts,
  readings: readonly UsageAccount[],
  sessions: readonly WorktreeSession[] = loadHistory(),
): AccountOverview[] {
  return accounts.list().map((a) => {
    const users = sessionsOnAccount(a.name, accounts, sessions);
    return {
      name: a.name,
      dir: a.dir,
      isDefault: a.isDefault,
      loggedIn: a.loggedIn,
      live: users.live,
      archived: users.archived,
      usage: readings.find((r) => r.account === a.name) ?? null,
    };
  });
}

/** The agent's account administration, or the refusal every caller says the same way. */
function adminOf(accounts: AgentAccounts | undefined): AgentAccountAdmin {
  if (!accounts?.admin) throw new AccountAdminError('its accounts are not managed by work');
  return accounts.admin;
}

/** Record a new account (its folder: `folder`, else the agent's default place, made when missing). Returns the folder. */
export async function addAgentAccount(accounts: AgentAccounts | undefined, name: string, folder?: string): Promise<string> {
  return adminOf(accounts).add(name, folder?.trim() || undefined);
}

/** New sessions use this account. */
export async function setDefaultAgentAccount(accounts: AgentAccounts | undefined, name: string): Promise<void> {
  return adminOf(accounts).setDefault(name);
}

export interface SkillsOutcome {
  ok: boolean;
  message: string;
}

/** What the login terminals need: the account lookup, the PTY host, and work's skills install for one account. */
export interface AccountLoginDeps {
  has(name: string): boolean;
  /** Start (or find running) the account's login terminal in the PTY host; its id. */
  start(name: string): Promise<string>;
  stop(name: string): Promise<void>;
  /** Put work's skills into the account's folder (slow: the agent's own CLI, several times). */
  installSkills(name: string): Promise<SkillsOutcome>;
  /** How an install went (the Activity panel). */
  note?(name: string, outcome: SkillsOutcome): void;
}

export interface AccountLogins {
  /** The login terminal's id. Refused (AccountAdminError) for an account there isn't. */
  start(name: string): Promise<string>;
  /**
   * Stop the login terminal. The first time for an account in this process, work's skills go into its folder after —
   * as `work account add` installs them once the login is over (installing while the agent writes its settings would
   * race it). `skills`: that install, under way (null: none started); nobody need wait for it.
   */
  stop(name: string): Promise<{ skills: Promise<SkillsOutcome> | null }>;
}

export function createAccountLogins(deps: AccountLoginDeps): AccountLogins {
  const installed = new Set<string>();
  const installing = new Set<string>();
  return {
    async start(name) {
      if (!deps.has(name)) throw new AccountAdminError(`no account “${name}”`);
      return deps.start(name);
    },
    async stop(name) {
      await deps.stop(name);
      if (!deps.has(name) || installed.has(name) || installing.has(name)) return { skills: null };
      installing.add(name);
      const skills = deps
        .installSkills(name)
        .catch((e: unknown): SkillsOutcome => ({ ok: false, message: e instanceof Error ? e.message : String(e) }))
        .then((r) => {
          installing.delete(name);
          // A failed install is tried again at the next close.
          if (r.ok) installed.add(name);
          deps.note?.(name, r);
          return r;
        });
      return { skills };
    },
  };
}

/** How a skills install for an account went, as an Activity run (kind `accounts`): a failure lights the Activity dot. */
export function accountSkillsNote(activity: Pick<ActivityLog, 'start'>): NonNullable<AccountLoginDeps['note']> {
  return (name, r) => {
    const run = activity.start('accounts', `Work's skills for the ${name} account`);
    if (r.ok) run.done(r.message);
    else {
      run.note(`${r.message} — or run \`work account skills ${name}\``, { level: 'warn' });
      run.fail(r.message);
    }
  };
}
