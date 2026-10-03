import spawn from 'cross-spawn';
import type { AgentSkills } from './types.js';

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

/** Runs `claude <args>` (argv only, §1.1); injectable for tests. */
export type ClaudeRun = (args: string[]) => { ok: boolean; stdout: string };

const runClaude: ClaudeRun = (args) => {
  const r = spawn.sync('claude', args, { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: 'pipe' });
  return { ok: !r.error && r.status === 0, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
};

export function claudeSkillsWith(run: ClaudeRun): AgentSkills {
  return {
    async install() {
      if (!run(['--version']).ok) return { ok: false, message: 'Claude Code (the `claude` CLI) is not installed' };
      const list = run(['plugin', 'marketplace', 'list']);
      if (!(list.ok && list.stdout.includes(MARKETPLACE_NAME))) {
        const add = run(['plugin', 'marketplace', 'add', MARKETPLACE_REPO, '--scope', 'user', '--sparse', '.claude-plugin']);
        if (!add.ok) return { ok: false, message: `could not register the Claude Code plugin marketplace (run \`claude plugin marketplace add ${MARKETPLACE_REPO}\`)` };
      }
      // Already installed, or a transient failure: either way not an error worth more than a line.
      const install = run(['plugin', 'install', PLUGIN_SPEC, '--scope', 'user']);
      return install.ok ? { ok: true, message: `installed the Claude Code plugin ${PLUGIN_SPEC}` } : { ok: true, message: `the Claude Code plugin ${PLUGIN_SPEC} is registered` };
    },
  };
}

export const claudeSkills: AgentSkills = claudeSkillsWith(runClaude);
