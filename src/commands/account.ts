import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { AccountAdminError, agentFor, type AgentAccounts } from '../core/agents/index.js';
import { loadConfig } from '../core/platform/config.js';
import { callWorkWeb } from '../core/platform/web-discovery.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { createAccountSwitcher } from '../core/sessions/account-switch.js';
import { defaultAccountSwitchDeps } from '../core/sessions/account-switch-deps.js';
import { removeAgentAccount } from '../core/sessions/account-users.js';
import { accountOverview, addAgentAccount, setDefaultAgentAccount } from '../core/sessions/account-admin.js';
import { listHostPtys } from '../core/pty/pty-pool.js';
import { agedWindow, usageText } from '../core/usage/usage.js';
import type { AccountSwitchAllWire, AccountSwitchWire } from '../core/api-types.js';
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

// The usage line is core's (the dashboard's Accounts page says the same); kept exported here for older callers.
export { ageText, usageText } from '../core/usage/usage.js';

function list(json: boolean): void {
  const found = accountsOrFail();
  if (!found) return;
  const { accounts } = found;
  const now = Date.now();
  const readings = agentFor(loadConfig()).usage?.read() ?? [];
  const overview = accountOverview(accounts, readings);
  const rows = overview.map((a) => ({
    name: a.name,
    folder: a.dir,
    default: a.isDefault,
    loggedIn: a.loggedIn,
    liveSessions: a.live.length,
    usage: a.usage
      ? {
          at: a.usage.at,
          ageMs: Math.max(0, now - Date.parse(a.usage.at)) || 0,
          windows: a.usage.windows.map((w) => ({
            id: w.id,
            label: w.label,
            usedPercent: agedWindow(w, now).usedPercent,
            resetsAt: w.resetsAt,
          })),
        }
      : null,
  }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const r of rows) {
    const login = r.loggedIn === null ? 'login unknown' : r.loggedIn ? 'logged in' : 'not logged in';
    console.log(
      `${chalk.bold(r.name)}${r.default ? chalk.cyan(' (default)') : ''}  ${chalk.gray(r.folder)}  ${login}  ` +
        chalk.gray(`${r.liveSessions} live session${r.liveSessions === 1 ? '' : 's'}`) +
        `  ${usageText(overview.find((x) => x.name === r.name)?.usage, now)}`,
    );
  }
}

async function add(name: string | undefined, folder: string | undefined, login: boolean): Promise<void> {
  if (!name) return fail('Usage: work account add <name> [folder]');
  const found = accountsOrFail();
  if (!found) return;
  const dir = await addAgentAccount(found.accounts, name, folder);
  const admin = found.accounts.admin!;
  console.log(chalk.green(`Added account ${name}: ${dir}`));
  if (login) {
    console.log(chalk.gray(`Starting ${found.name} on it so you can log in: type /login, then exit when done.`));
    admin.login(name);
  }
  // Work's skills live in each account's folder: this one's too. Its hooks and status line come with each Claude work
  // starts on it (`--settings`, agents/session-hooks.ts): nothing to install.
  const skills = admin.installSkills(name);
  console.log(skills.ok ? chalk.gray(skills.message) : chalk.yellow(skills.message));
}

/** Work's skills into the account's folder (the dashboard's Accounts page runs this in a child after a first login). */
function skills(name: string | undefined): void {
  if (!name) return fail('Usage: work account skills <name>');
  const found = accountsOrFail();
  if (!found) return;
  if (!found.accounts.admin) return fail('its accounts are not managed by work');
  const r = found.accounts.admin.installSkills(name);
  if (r.ok) console.log(r.message);
  else fail(r.message);
}

async function setDefault(name: string | undefined): Promise<void> {
  if (!name) return fail('Usage: work account default <name>');
  const found = accountsOrFail();
  if (!found) return;
  await setDefaultAgentAccount(found.accounts, name);
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

/** Copy `from`'s setup to `to` (`work account copy-setup <to> --from <from>`); `dryRun`: only say what it would do. */
async function copySetup(to: string | undefined, from: string | undefined, dryRun: boolean): Promise<void> {
  if (!to || !from) return fail('Usage: work account copy-setup <to> --from <from> [--dry-run]');
  const found = accountsOrFail();
  if (!found) return;
  const admin = found.accounts.admin;
  if (!admin?.setupPlan || !admin.copySetup) return fail(`${found.name} has no setup to copy`);
  const plan = admin.setupPlan(from, to);
  if (plan.length === 0) return void console.log(chalk.green(`${to} already has ${from}'s setup: nothing to copy.`));
  if (dryRun) {
    console.log(`Copying ${from}'s setup to ${to} would do ${plan.length} thing${plan.length === 1 ? '' : 's'}:`);
    for (const i of plan) console.log(`  ${i.does} ${i.kind} ${i.name}${i.note ? chalk.gray(` — ${i.note}`) : ''}`);
    return;
  }
  console.log(
    chalk.gray(
      `Copying ${plan.length} thing${plan.length === 1 ? '' : 's'} from ${from} to ${to} (plugins are installed from their marketplaces: this can take a minute)…`,
    ),
  );
  const done = await admin.copySetup(from, to);
  for (const i of done)
    console.log(
      i.ok
        ? `  ${chalk.green('✓')} ${i.kind} ${i.name}${i.note ? chalk.gray(` — ${i.note}`) : ''}`
        : `  ${chalk.red('✗')} ${i.kind} ${i.name}: ${i.error}`,
    );
  const failed = done.filter((i) => !i.ok).length;
  console.log(
    (failed ? chalk.yellow : chalk.green)(
      `Copied ${done.length - failed} of ${done.length}${failed ? `; ${failed} failed` : ''}. Restart a session's Claude for it to see them.`,
    ),
  );
  if (failed) process.exitCode = 1;
}

/** Move every session (or those on `from`) to the account `to`: work web does it, one session after another. */
async function switchAll(to: string | undefined, from: string | undefined): Promise<void> {
  if (!to) return fail('Usage: work account switch --all --to <name> [--from <name>]');
  const r = await callWorkWeb<AccountSwitchAllWire>(
    'POST',
    `/api/accounts/${encodeURIComponent(to)}/sessions`,
    from ? { from } : {},
    900_000,
  );
  if (!r.ok) return fail(r.status === 0 ? 'work web is not running: start it (or open the app) and run this again' : r.error);
  console.log(chalk.green(r.body.summary));
  for (const s of r.body.sessions)
    console.log(s.outcome ? chalk.gray(`  ${s.label}: ${OUTCOME_TEXT[s.outcome]}`) : chalk.yellow(`  ${s.label}: ${s.error}`));
}

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
  describe:
    "The agent's accounts (Claude Code logins): add, list, default, remove, switch, copy-setup (also on the dashboard's Accounts page)",
  builder: (yargs) =>
    yargs
      .positional('action', {
        describe: 'What to do',
        choices: ['add', 'list', 'default', 'remove', 'switch', 'skills', 'copy-setup'] as const,
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
      .option('all', { type: 'boolean', describe: 'switch: every session (not archived ones), not one' })
      .option('from', {
        type: 'string',
        describe: 'switch --all: only the sessions on this account; copy-setup: the account whose setup is copied',
      })
      .option('dry-run', { type: 'boolean', describe: 'copy-setup: only say what it would copy' })
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
        case 'copy-setup':
          return await copySetup(name, argv.from as string | undefined, argv.dryRun === true);
        case 'switch':
          // For a switch the two positionals are the session's: <target> [branch] (none: the session for this folder).
          if (argv.all) return await switchAll(argv.to as string | undefined, argv.from as string | undefined);
          return await switchSession(name, argv.folder as string | undefined, argv.to as string | undefined);
        case 'remove':
          return await remove(name, argv.force === true);
        case 'skills':
          return skills(name);
      }
    } catch (e) {
      if (!(e instanceof AccountAdminError)) throw e;
      fail(e.sessions.length ? `${e.message}: ${e.sessions.join(', ')}` : e.message);
    }
  },
};
