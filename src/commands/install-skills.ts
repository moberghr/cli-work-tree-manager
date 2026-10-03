import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { installSkills } from '../core/skills.js';

/**
 * `work install-skills` (hidden) — give each agent work knows its skills
 * (core/skills.ts). Run by npm's postinstall and the desktop app's first
 * start; best-effort, so it always exits 0.
 */
export const installSkillsCommand: CommandModule = {
  command: 'install-skills',
  describe: false,
  handler: async () => {
    for (const r of await installSkills()) console.log(`work-tree: ${r.agent}: ${r.ok ? r.message : chalk.yellow(r.message)}`);
  },
};
