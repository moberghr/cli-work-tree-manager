import chalk from 'chalk';
import type { CommandModule } from 'yargs';
import { installSkills } from '../core/skills.js';

/** Give each agent work knows its skills (core/skills.ts) and say how it went, a line per agent. Best-effort: never throws. */
export async function runInstallSkills(): Promise<void> {
  for (const r of await installSkills()) console.log(`work-tree: ${r.agent}: ${r.ok ? r.message : chalk.yellow(r.message)}`);
}

/**
 * `work install-skills` (hidden) — the same by hand. npm's postinstall and
 * the desktop app's first start run dist/install-skills-bin.js, which is
 * only this: not the whole CLI (no logger, nothing written to ~/.work).
 */
export const installSkillsCommand: CommandModule = {
  command: 'install-skills',
  describe: false,
  handler: runInstallSkills,
};
