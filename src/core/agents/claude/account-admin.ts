import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAiTool } from '../../platform/ai-launcher.js';
import { DEFAULT_ACCOUNT, getConfigPath, loadConfig } from '../../platform/config.js';
import { applyEnvDelta } from '../../platform/env-delta.js';
import { atomicWriteFile, withFileLock } from '../../platform/fs-safe.js';
import spawn from '../../platform/spawn.js';
import { AccountAdminError, type AccountUsers, type AgentAccountAdmin } from '../types.js';
import { accountDir, accountEnv, accountForbiddenRoots, accountProblem, expandAccountDir, validateClaudeAccounts } from './accounts.js';
import { withoutParentSession } from './env.js';
import { installClaudeSkillsFor } from './skills.js';

/**
 * Changes to the Claude accounts in config.json, as raw JSON under the config's lock (repo-admin.ts does the same), so a
 * setting this code doesn't know is never lost. Never deletes a folder: an account's login and conversations are the user's.
 */

type RawConfig = Record<string, unknown> & { claudeAccounts?: Record<string, string>; claudeAccount?: string };

async function editConfig<T>(fn: (raw: RawConfig, accounts: Record<string, string>) => T): Promise<T> {
  const file = getConfigPath();
  if (!fs.existsSync(file)) throw new AccountAdminError('No configuration yet: run `work init` first.');
  return withFileLock(file, () => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as RawConfig;
    const existing = raw.claudeAccounts;
    const accounts = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...existing } : {};
    const out = fn(raw, accounts);
    raw.claudeAccounts = accounts;
    if (!Object.keys(accounts).length) delete raw.claudeAccounts;
    atomicWriteFile(file, JSON.stringify(raw, null, 2));
    return out;
  });
}

/** The accounts the config has by the rules (accounts.ts): a written entry that isn't one doesn't count as one here either. */
const validIn = (raw: RawConfig): Record<string, string> =>
  validateClaudeAccounts(raw.claudeAccounts, undefined, accountForbiddenRoots(raw)).accounts ?? {};

/** Add an account: its folder (default `~/.claude-<name>`) is made, the name and folder must be free. Returns the folder. */
export async function addAccount(name: string, dir?: string): Promise<string> {
  const folder = expandAccountDir(dir?.trim() || path.join(os.homedir(), `.claude-${name}`));
  if (!folder) throw new AccountAdminError(`${dir} is not an absolute folder`);
  return editConfig((raw, accounts) => {
    if (name in accounts) throw new AccountAdminError(`there is already an account “${name}”`);
    const problem = accountProblem(name, folder, Object.values(validIn(raw)), accountForbiddenRoots(raw));
    if (problem) throw new AccountAdminError(problem);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (e) {
      throw new AccountAdminError(`couldn't make ${folder}: ${e instanceof Error ? e.message : String(e)}`);
    }
    accounts[name] = folder;
    return folder;
  });
}

/** New sessions use this account (`default` or a configured one). */
export async function setDefaultAccount(name: string): Promise<void> {
  await editConfig((raw) => {
    if (name !== DEFAULT_ACCOUNT && !(name in validIn(raw))) throw new AccountAdminError(`no account “${name}”`);
    raw.claudeAccount = name;
  });
}

const sessionsText = (n: number, what: string) => `${n} ${what} session${n === 1 ? '' : 's'}`;

/**
 * Forget an account (its folder stays). `usedBy` is asked under the config's lock, right before the write: refused,
 * naming them, while live sessions run on it, or archived ones would need it to be restored; the default falls back to
 * `default`.
 */
export async function removeAccount(name: string, usedBy: () => AccountUsers): Promise<void> {
  if (name === DEFAULT_ACCOUNT) throw new AccountAdminError('the default account (~/.claude) can not be removed');
  await editConfig((raw, accounts) => {
    if (!(name in accounts)) throw new AccountAdminError(`no account “${name}”`);
    const { live, archived } = usedBy();
    if (live.length) throw new AccountAdminError(`${sessionsText(live.length, 'live')} on ${name}`, live, 'live');
    if (archived.length)
      throw new AccountAdminError(
        `${sessionsText(archived.length, 'archived')} on ${name} (a Restore would start it on the default account instead)`,
        archived,
        'archived',
      );
    delete accounts[name];
    if (raw.claudeAccount === name) raw.claudeAccount = DEFAULT_ACCOUNT;
  });
}

/**
 * Claude Code in this terminal on the account, so you `/login` once: the configured command when it is Claude (`claude
 * --model …`, config `aiCommand`), with the account's folder in its environment. The login is the user's, in this
 * terminal (stdio inherited): nothing to hide. Blocks until it exits.
 */
export function loginOn(name: string, run: typeof spawn.sync = spawn.sync): void {
  if (!accountDir(name)) throw new AccountAdminError(`no account “${name}”`);
  const config = loadConfig();
  const tool = getAiTool(config && getAiTool(config).cmd === 'claude' ? config : {});
  const env = applyEnvDelta(withoutParentSession(process.env), accountEnv(name)) as NodeJS.ProcessEnv;
  run(tool.cmd, tool.baseArgs, { stdio: 'inherit', windowsHide: false, env });
}

/** Claude's account administration (types.ts `AgentAccountAdmin`). */
export const claudeAccountAdmin: AgentAccountAdmin = {
  add: addAccount,
  setDefault: setDefaultAccount,
  remove: removeAccount,
  login: (name) => loginOn(name),
  installSkills: (name) => {
    const dir = accountDir(name);
    if (!dir) return { ok: false, message: `no account “${name}”` };
    return installClaudeSkillsFor(dir);
  },
};
