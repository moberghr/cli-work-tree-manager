import { applyEnvDelta, type EnvDelta } from '../../platform/env-delta.js';
import spawn from '../../platform/spawn.js';
import { setUpAccounts, type ClaudeAccount } from './accounts.js';
import type { AgentSkills } from '../types.js';

/**
 * Claude Code's side of work's skills (types.ts `AgentSkills`): they ship as
 * a Claude Code plugin (`work-tree`, .claude-plugin/marketplace.json →
 * plugins/work-tree), so installing them is registering that marketplace and
 * installing the plugin, user-wide, with the `claude` CLI. Claude reads the
 * plugin from the marketplace, not from the local folder.
 */

export const MARKETPLACE_REPO = 'moberghr/moberg-plugins';
export const MARKETPLACE_NAME = 'moberg-plugins';
export const PLUGIN_SPEC = 'work-tree@moberg-plugins';

/** Runs `claude <args>` (argv only, §1.1), with `env` applied over this process's environment (an account's `CLAUDE_CONFIG_DIR`); injectable for tests. */
export type ClaudeRun = (args: string[], env?: EnvDelta) => { ok: boolean; stdout: string; stderr?: string };

const runClaude: ClaudeRun = (args, env) => {
  const r = spawn.sync('claude', args, {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    stdio: 'pipe',
    ...(env ? { env: applyEnvDelta(process.env, env) as NodeJS.ProcessEnv } : {}),
  });
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  return { ok: !r.error && r.status === 0, stdout: text(r.stdout), stderr: r.error ? r.error.message : text(r.stderr) };
};

/** The last line a command printed, for a failure's reason. */
const lastLine = (r: { stdout: string; stderr?: string }) =>
  `${r.stderr ?? ''}\n${r.stdout}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop() ?? '';

/** Whether `claude plugin list --json` (an array of `{ id: "name@marketplace", … }`) lists work's plugin. */
export function isInstalled(listJson: string): boolean {
  try {
    const list = JSON.parse(listJson) as unknown;
    return Array.isArray(list) && list.some((p) => !!p && typeof p === 'object' && (p as { id?: unknown }).id === PLUGIN_SPEC);
  } catch {
    return false;
  }
}

/** Installs the plugin for ONE account: `run` carries that account's environment. */
function installFor(run: (args: string[]) => ReturnType<ClaudeRun>): { ok: boolean; message: string } {
  if (!run(['--version']).ok) return { ok: false, message: 'Claude Code (the `claude` CLI) is not installed' };
  const list = run(['plugin', 'marketplace', 'list']);
  if (!(list.ok && list.stdout.includes(MARKETPLACE_NAME))) {
    const add = run(['plugin', 'marketplace', 'add', MARKETPLACE_REPO, '--scope', 'user', '--sparse', '.claude-plugin']);
    if (!add.ok)
      return {
        ok: false,
        message: `could not register the Claude Code plugin marketplace (run \`claude plugin marketplace add ${MARKETPLACE_REPO}\`)`,
      };
  }
  const install = run(['plugin', 'install', PLUGIN_SPEC, '--scope', 'user']);
  if (install.ok) return { ok: true, message: `installed the Claude Code plugin ${PLUGIN_SPEC}` };
  // Installed before is fine (`claude plugin list --json` has it); anything else (offline, a timeout, auth) is a failure, with how to do it by hand.
  if (isInstalled(run(['plugin', 'list', '--json']).stdout))
    return { ok: true, message: `the Claude Code plugin ${PLUGIN_SPEC} is installed` };
  const why = lastLine(install);
  return {
    ok: false,
    message: `could not install the Claude Code plugin${why ? ` (${why})` : ''}: run \`claude plugin install ${PLUGIN_SPEC} --scope user\``,
  };
}

/**
 * The plugin lives in each account's config folder (`~/.claude/plugins`, or the account's own): installed once per account,
 * with that account's `CLAUDE_CONFIG_DIR`. With no account configured it is the single plain run it always was.
 */
export function claudeSkillsWith(run: ClaudeRun, accounts: () => ClaudeAccount[] = setUpAccounts): AgentSkills {
  return {
    async install() {
      const list = accounts();
      if (list.length <= 1) return installFor((args) => run(args));
      const results = list.map((a) => {
        // The default account takes any inherited folder out, so it never lands in another account's.
        const env: EnvDelta = a.name === 'default' ? { CLAUDE_CONFIG_DIR: null } : { CLAUDE_CONFIG_DIR: a.dir };
        return { name: a.name, ...installFor((args) => run(args, env)) };
      });
      return { ok: results.every((r) => r.ok), message: results.map((r) => `${r.name}: ${r.message}`).join('; ') };
    },
  };
}

export const claudeSkills: AgentSkills = claudeSkillsWith(runClaude);

/** Work's plugin into ONE account's folder: a new account (`work account add`), which the install at setup didn't reach. */
export function installClaudeSkillsFor(dir: string, run: ClaudeRun = runClaude): { ok: boolean; message: string } {
  return installFor((args) => run(args, { CLAUDE_CONFIG_DIR: dir }));
}
