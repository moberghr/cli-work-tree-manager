import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { knownAgents } from './agents/index.js';
import type { AgentAdapter } from './agents/types.js';

/**
 * work's skills — how to use `work` (work-sessions) and `wd -c` (wd-review) —
 * are SKILL.md folders under plugins/work-tree/skills, the Agent Skills
 * format. Each agent's adapter makes them available its own way
 * (types.ts `AgentSkills`; Claude's: its plugin marketplace). Run at npm
 * install (scripts/postinstall.mjs → dist/install-skills-bin.js) and by the
 * desktop app's first start; `work install-skills` by hand.
 */

/** The shipped skills folder: next to dist/ in the package, or the repo's in dev. */
export function skillsDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [
    path.resolve(moduleDir, '..', 'plugins', 'work-tree', 'skills'), // bundled: dist/bin.js
    path.resolve(moduleDir, '..', '..', 'plugins', 'work-tree', 'skills'), // dev: src/core
  ]) {
    if (fs.existsSync(path.join(c, 'work-sessions', 'SKILL.md'))) return c;
  }
  return null;
}

export interface SkillsInstall {
  agent: string;
  ok: boolean;
  message: string;
}

/** Give every agent work knows that can take skills the shipped ones. Never throws: each agent's outcome is reported. */
export async function installSkills(agents: AgentAdapter[] = knownAgents(), dir: string | null = skillsDir()): Promise<SkillsInstall[]> {
  const out: SkillsInstall[] = [];
  for (const a of agents) {
    if (!a.skills) continue;
    // A missing folder is each agent's to judge: Claude's come from its marketplace, not from here.
    try {
      out.push({ agent: a.name, ...(await a.skills.install({ skillsDir: dir })) });
    } catch (err) {
      out.push({ agent: a.name, ok: false, message: (err as Error).message });
    }
  }
  return out;
}
