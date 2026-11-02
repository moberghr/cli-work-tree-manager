import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { AccountAdminError, agentFor, type AgentAccounts } from '../core/agents/index.js';
import { loadConfig } from '../core/platform/config.js';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { createAccountSwitcher } from '../core/sessions/account-switch.js';
import { defaultAccountSwitchDeps } from '../core/sessions/account-switch-deps.js';
import { removeAgentAccount, sessionsOnAccount } from '../core/sessions/account-users.js';
import { listHostPtys } from '../core/pty/pty-pool.js';
import { agedWindow, type UsageAccount } from '../core/usage/usage.js';
import type { AccountSwitchWire } from '../core/api-types.js';
import { sessionFromArgs } from './shared/session-arg.js';

/**
 * `work account` — the accounts (logins) of the configured agent (Claude Code: each a config folder,
 * `CLAUDE_CONFIG_DIR`), so a second login can take over when the first one's limit runs out. add / list / default /
 * remove, and switch: move a session to another account (`work account switch [target] [branch] --to <name>`). Every
 * piece of it goes through the agent's adapter (its `accounts` part): nothing here knows Claude.
 */

function fail(message: string): void {
  console.error(chalk.red(message));
  process.exitCode = 1;
}

/** The configured agent's accounts part, or null (said) when it has none. */
function accountsOrFail(): { name: string; accounts: AgentAccounts } | null {
  const agent = agentFor(loadConfig());
  if (agent.accounts) return { name: agent.name, accounts: agent.accounts };
  fail(`${agent.name} has no accounts work knows about`);
  return null;
}

/** How long ago, in a few words. */
export function ageText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** An account's last usage reading in a line ("5-hour limit 42% · Weekly limit 18% · read 3 min ago"); a window past its reset reads 0. */
export function usageText(reading: UsageAccount | undefined, now = Date.now()): string {
  if (!reading || reading.windows.length === 0) return 'no usage reading yet';
  const windows = reading.windows.map((w) => `${w.label} ${Math.round(agedWindow(w, now).usedPercent)}%`);
  const at = Date.parse(reading.at);
  return [...windows, Number.isFinite(at) ? `read ${ageText(now - at)}` : ''].filter(Boolean).join(' · ');
}

function list(json: boolean): void {
  const found = accountsOrFail();
  if (!found) return;
  const { accounts } = found;
  const now = Date.now();
  const readings = agentFor(loadConfig()).usage?.read() ?? [];
  const rows = accounts.list().map((a) => {
    const reading = readings.find((r) => r.account === a.name);
    return {
      name: a.name,
      folder: a.dir,
      default: a.isDefault,
      loggedIn: a.loggedIn,
      liveSessions: sessionsOnAccount(a.name, accounts).live.length,
      usage: reading
        ? {
            at: reading.at,
            ageMs: Math.max(0, now - Date.parse(reading.at)) || 0,
            windows: reading.windows.map((w) => ({
              id: w.id,
              label: w.label,
              usedPercent: agedWindow(w, now).usedPercent,
              resetsAt: w.resetsAt,
            })),
          }
        : null,
    };
  });
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of rows) {
    const login = r.loggedIn === null ? 'login unknown' : r.loggedIn ? 'logged in' : 'not logged in';
    console.log(
      `${chalk.bold(r.name)}${r.default ? chalk.cyan(' (default)') : ''}  ${chalk.gray(r.folder)}  ${login}  ` +
        chalk.gray(`${r.liveSessions} live session${r.liveSessions === 1 ? '' : 's'}`) +
        `  ${usageText(
          readings.find((x) => x.account === r.name),
          now,
        )}`,
    );
  }
}

async function add(name: string | undefined, folder: string | undefined, login: boolean): Promise<void> {
  if (!name) return fail('Usage: work account add <name> [folder]');
  const found = accountsOrFail();
  if (!found) return;
  const admin = found.accounts.admin;
  if (!admin) return fail(`${found.name}'s accounts are not managed by work`);
  const dir = await admin.add(name, folder);
  console.log(chalk.green(`Added account ${name}: ${dir}`));
  if (login) {
    console.log(chalk.gray(`Starting ${found.name} on it so you can log in: type /login, then exit when done.`));
    admin.login(name);
  }
  // Work's skills live in each account's folder: this one's too. Its hooks and status line: a running work web adds
  // them within seconds (account-sync.ts), else the next start does.
  const skills = admin.installSkills(name);
  console.log(skills.ok ? chalk.gray(skills.message) : chalk.yellow(skills.message));
}

async function setDefault(name: string | undefined): Promise<void> {
  if (!name) return fail('Usage: work account default <name>');
  const found = accountsOrFail();
  if (!found) return;
  if (!found.accounts.admin) return fail(`${found.name}'s accounts are not managed by work`);
  await found.accounts.admin.setDefault(name);
  console.log(chalk.green(`New sessions use the ${name} account.`));
}

async function remove(name: string | undefined, force: boolean): Promise<void> {
  if (!name) return fail('Usage: work account remove <name> [--force]');
  const found = accountsOrFail();
  if (!found) return;
  try {
    await removeAgentAccount(found.accounts, name, { force });
  } catch (e) {
    if (e instanceof AccountAdminError && e.kind === 'archived')
      return fail(`${e.message}: ${e.sessions.join(', ')}. Restore them on another account first, or --force to remove it anyway`);
    throw e;
  }
  console.log(chalk.green(`Removed account ${name} (its folder is left as it is).`));
}

const OUTCOME_TEXT: Record<AccountSwitchWire['outcome'], string> = {
  switched: 'its Claude restarted on it (its conversation goes on)',
  queued: 'it is working or waiting on you: the switch happens when its turn ends',
  recorded: 'its Claude is not running: the next start uses it',
};

/** Move the session for `target` / `branch` (or this folder) to the account `to`. */
async function switchSession(target: string | undefined, branch: string | undefined, to: string | undefined): Promise<void> {
  if (!to) return fail('Usage: work account switch [target] [branch] --to <name>');
  const s = sessionFromArgs({ target, branch });
  if (!s) return;
  const id = sessionIdFor(s);
  const label = `${s.target} · ${s.branch}`;
  // Only work web can drive its terminal; waits for the old process to stop and the move to finish.
  const r = await callWorkWeb<AccountSwitchWire>('POST', `/api/sessions/${id}/account`, { to }, 90_000);
  if (r.ok) {
    console.log(chalk.green(`${label}: moved to the ${to} account${r.body.moved ? ` (${r.body.moved} conversation entries moved)` : ''}`));
    console.log(chalk.gray(OUTCOME_TEXT[r.body.outcome]));
    return;
  }
  if (r.status !== 0) return fail(`${label}: ${r.error}`);
  // No work web: nothing here can stop or start a Claude in the PTY host, so only a session whose Claude isn't running goes.
  if ((await listHostPtys().catch(() => [])).some((p) => p.id === id && !p.exited)) {
    return fail(`${label}: its Claude runs in the PTY host: start work web (or open the app) and run this again`);
  }
  const local = await createAccountSwitcher(defaultAccountSwitchDeps({ busy: () => false, hostRuns: () => false })).switchAccount(id, to);
  if (!local.ok) return fail(`${label}: ${local.error}`);
  console.log(chalk.green(`${label}: moved to the ${to} account${local.moved ? ` (${local.moved} conversation entries moved)` : ''}`));
  console.log(chalk.gray(`${OUTCOME_TEXT.recorded}. (work web is not running.)`));
}

export const accountCommand: CommandModule = {
  command: 'account <action> [name] [folder]',
  describe: "The agent's accounts (Claude Code logins): add, list, default, remove, switch",
  builder: (yargs) =>
    yargs
      .positional('action', {
        describe: 'What to do',
        choices: ['add', 'list', 'default', 'remove', 'switch'] as const,
        type: 'string',
        demandOption: true,
      })
      .positional('name', {
        describe: 'The account name (lower-case letters, digits, dashes); switch: the session’s repo or group',
        type: 'string',
      })
      .positional('folder', {
        describe: 'add: its Claude config folder (default ~/.claude-<name>); switch: the session’s branch',
        type: 'string',
      })
      .option('to', { type: 'string', describe: 'switch: the account to move the session to' })
      .option('json', { type: 'boolean', describe: 'list: print JSON' })
      .option('force', {
        type: 'boolean',
        describe: 'remove: even though archived sessions use it (their Restore starts on the default account)',
      })
      .option('login', {
        type: 'boolean',
        default: true,
        describe: 'add: start Claude on the new account to log in (--no-login skips it)',
      }),
  handler: async (argv) => {
    const action = argv.action as string;
    const name = argv.name as string | undefined;
    try {
      switch (action) {
        case 'add':
          return await add(name, argv.folder as string | undefined, argv.login !== false);
        case 'list':
          return list(argv.json === true);
        case 'default':
          return await setDefault(name);
        case 'switch':
          // For a switch the two positionals are the session's: <target> [branch] (none: the session for this folder).
          return await switchSession(name, argv.folder as string | undefined, argv.to as string | undefined);
        case 'remove':
          return await remove(name, argv.force === true);
      }
    } catch (e) {
      if (!(e instanceof AccountAdminError)) throw e;
      fail(e.sessions.length ? `${e.message}: ${e.sessions.join(', ')}` : e.message);
    }
  },
};
