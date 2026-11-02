import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_ACCOUNT, type WorkConfig } from '../../platform/config.js';
import { configView } from '../../platform/config-cache.js';
import type { EnvDelta } from '../../platform/env-delta.js';
import { report } from '../../platform/report.js';

/**
 * Claude Code accounts: each is a config folder (`CLAUDE_CONFIG_DIR`). The default one is `~/.claude`, with no env set;
 * the others come from config `claudeAccounts`, which config.ts keeps as written — the rules for what makes one an
 * account are here. Kept light (node builtins, the config cache): launch paths ask it.
 */

export interface ClaudeAccount {
  name: string;
  dir: string;
  isDefault: boolean;
}

/** The config an account lookup reads: the accounts as written, and the folders an account's can't be in. */
type AccountConfig = (Pick<WorkConfig, 'claudeAccounts' | 'claudeAccount'> & Partial<Pick<WorkConfig, 'worktreesRoot' | 'repos'>>) | null;

export const ACCOUNT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The default account's folder. */
export const defaultAccountDir = (): string => path.join(os.homedir(), '.claude');

/** A folder as written in config: a leading `~` expanded; undefined when the result isn't absolute. */
export function expandAccountDir(dir: string): string | undefined {
  const home = os.homedir();
  const expanded = dir === '~' ? home : /^~[\\/]/.test(dir) ? path.join(home, dir.slice(2)) : dir;
  return path.isAbsolute(expanded) ? expanded : undefined;
}

/** Folders compare case-blind on Windows. */
export const accountDirKey = (dir: string): string => {
  const n = path.resolve(dir).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};

/** `dir` is `root` or inside it (keys from accountDirKey). */
const sameOrInside = (dirKey: string, rootKey: string): boolean => dirKey === rootKey || dirKey.startsWith(rootKey + path.sep);

/**
 * Why `name` / `dir` can't be an account (a reason to show), or null. `taken` = the folders other accounts have;
 * `roots` = folders an account's must not be or be inside (the worktrees root, every repo, `~/.work`): Claude writes
 * its login and conversations there, which git would see, a worktree's removal would delete, or work's own state holds.
 */
export function accountProblem(name: string, dir: string, taken: Iterable<string> = [], roots: Iterable<string> = []): string | null {
  if (name === DEFAULT_ACCOUNT) return `“${DEFAULT_ACCOUNT}” is the account at ~/.claude and can't be reused`;
  if (!ACCOUNT_NAME_RE.test(name)) return `“${name}” is not a valid account name (lower-case letters, digits and dashes, up to 32)`;
  if (!path.isAbsolute(dir)) return `${dir} is not an absolute folder`;
  const key = accountDirKey(dir);
  if (key === accountDirKey(defaultAccountDir())) return '~/.claude is the default account';
  for (const t of taken) if (accountDirKey(t) === key) return `${dir} is already another account's folder`;
  for (const r of roots) {
    if (!r || !path.isAbsolute(r)) continue;
    if (sameOrInside(key, accountDirKey(r))) return `${dir} is inside ${r}: an account's folder can't be in a worktree, a repo or ~/.work`;
  }
  return null;
}

/** The folders an account's can't be in: the worktrees root, each repo, work's own folder (`~/.work`, not made by asking). */
export function accountForbiddenRoots(config: Record<string, unknown> | null | undefined): string[] {
  const roots: string[] = [path.join(os.homedir(), '.work')];
  if (!config) return roots;
  if (typeof config.worktreesRoot === 'string' && config.worktreesRoot) roots.push(config.worktreesRoot);
  if (config.repos && typeof config.repos === 'object' && !Array.isArray(config.repos))
    for (const p of Object.values(config.repos as Record<string, unknown>)) if (typeof p === 'string' && p) roots.push(p);
  return roots;
}

/**
 * `claudeAccounts` / `claudeAccount` as written, by the rules: only well-formed accounts (each bad one named in
 * `problems`), and the default only when it is `default` or one that survived.
 */
export function validateClaudeAccounts(
  rawAccounts: unknown,
  rawDefault: unknown,
  roots: Iterable<string> = [],
): { accounts?: Record<string, string>; account?: string; problems: string[] } {
  const accounts: Record<string, string> = {};
  const problems: string[] = [];
  const forbidden = [...roots];
  if (rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts)) {
    for (const [name, v] of Object.entries(rawAccounts as Record<string, unknown>)) {
      const dir = typeof v === 'string' ? expandAccountDir(v.trim()) : undefined;
      const problem = dir ? accountProblem(name, dir, Object.values(accounts), forbidden) : `${String(v)} is not an absolute folder`;
      if (problem || !dir) problems.push(`config claudeAccounts.${name} ignored: ${problem}`);
      else accounts[name] = dir;
    }
  }
  let account: string | undefined;
  if (typeof rawDefault === 'string') {
    if (rawDefault === DEFAULT_ACCOUNT || rawDefault in accounts) account = rawDefault;
    else problems.push(`config claudeAccount “${rawDefault}” ignored: no such account`);
  }
  return { ...(Object.keys(accounts).length ? { accounts } : {}), ...(account ? { account } : {}), problems };
}

/** The accounts of a config by the rules (what every lookup below works on). */
type Valid = { accounts: Record<string, string>; account?: string };
const validOf = (config: AccountConfig | Record<string, unknown>): Valid & { problems: string[] } => {
  const c = (config ?? null) as Record<string, unknown> | null;
  const v = validateClaudeAccounts(c?.claudeAccounts, c?.claudeAccount, accountForbiddenRoots(c));
  return { accounts: v.accounts ?? {}, ...(v.account ? { account: v.account } : {}), problems: v.problems };
};

/**
 * The accounts of config.json now, through the config cache (config-cache.ts, shared with agentSettings()): read and
 * checked again only when the file changed — so a bad entry is warned about once per change, not on every lookup (they
 * run per row of every session list).
 */
const currentView = configView((raw): Valid => {
  const v = validOf(raw);
  for (const p of v.problems) report('warn', p);
  return { accounts: v.accounts, ...(v.account ? { account: v.account } : {}) };
});

/** `config` as given (null: none) checked by the rules, or the current one when the caller passed nothing. */
const configOf = (config: AccountConfig | undefined): Valid => (config === undefined ? currentView() : validOf(config));

/** Every account: the default (`~/.claude`) first, then the configured ones by name. `isDefault` marks the one new sessions use. */
export function claudeAccounts(given?: AccountConfig): ClaudeAccount[] {
  const config = configOf(given);
  const chosen = chosenOf(config);
  const configured = Object.entries(config.accounts).sort(([a], [b]) => a.localeCompare(b));
  return [
    { name: DEFAULT_ACCOUNT, dir: defaultAccountDir(), isDefault: chosen === DEFAULT_ACCOUNT },
    ...configured.map(([name, dir]) => ({ name, dir, isDefault: chosen === name })),
  ];
}

/**
 * The accounts work sets up (hooks, the status line, the plugin): the default always (as it always was), a configured
 * one only once its folder exists — installing into it would make it, before `work account add` (or the user) does;
 * work web's account sync installs it once the folder is there.
 */
export function setUpAccounts(given?: AccountConfig): ClaudeAccount[] {
  return claudeAccounts(given).filter((a) => a.name === DEFAULT_ACCOUNT || fs.existsSync(a.dir));
}

const chosenOf = (config: Valid): string => config.account ?? DEFAULT_ACCOUNT;

/** An account's folder; null for a name that isn't one. */
export function accountDir(name: string, config?: AccountConfig): string | null {
  return claudeAccounts(config).find((a) => a.name === name)?.dir ?? null;
}

/** The account new sessions use: config `claudeAccount` when it names one, else `default`. */
export function defaultAccountName(given?: AccountConfig): string {
  return chosenOf(configOf(given));
}

/**
 * The account a session runs on: the one it recorded, else `default` — a row from before accounts ran on `~/.claude`,
 * whatever the configured default is now (that one is for sessions made from here on).
 */
export function sessionAccount(s: { account?: string } | null | undefined): string {
  return s?.account || DEFAULT_ACCOUNT;
}

/**
 * Whether Claude Code has credentials in this folder: its `.credentials.json` is there. On macOS they live in the
 * keychain and the file may never exist, so a missing one is unknown (null) there, not "no".
 */
export function isLoggedIn(dir: string, platform: NodeJS.Platform = process.platform): boolean | null {
  if (fs.existsSync(path.join(dir, '.credentials.json'))) return true;
  return platform === 'darwin' ? null : false;
}

/** The environment that points a Claude at an account: `CLAUDE_CONFIG_DIR` for a configured one, nothing for the default. */
export function configDirEnv(name: string, config?: AccountConfig): Record<string, string> {
  if (name === DEFAULT_ACCOUNT) return {};
  const dir = accountDir(name, config);
  return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
}

/**
 * What a Claude on this account needs in its environment, as a change to apply over the one it would inherit: a
 * configured account sets `CLAUDE_CONFIG_DIR`; the default account — once any account is configured — TAKES IT OUT
 * (`null`), so a shell that was opened on another account (or a host started from one) never puts a default session
 * on it. With no accounts configured the environment is left alone: someone who sets `CLAUDE_CONFIG_DIR` themselves
 * keeps that, as before accounts existed.
 */
export function accountEnv(name: string, given?: AccountConfig): EnvDelta {
  const config = configOf(given);
  const dir = name === DEFAULT_ACCOUNT ? null : (config.accounts[name] ?? null);
  if (dir) return { CLAUDE_CONFIG_DIR: dir };
  return Object.keys(config.accounts).length ? { CLAUDE_CONFIG_DIR: null } : {};
}
