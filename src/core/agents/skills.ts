import fs from 'node:fs';
import { packageRoot } from '../platform/package-root.js';
import path from 'node:path';
import { knownAgents } from './index.js';
import type { AgentAdapter } from './types.js';

/**
 * work's skills — how to use `work` (work-sessions) and `wd -c` (wd-review) —
 * are SKILL.md folders under plugins/work-tree/skills, the Agent Skills
 * format. Each agent's adapter makes them available its own way
 * (types.ts `AgentSkills`; Claude's: its plugin marketplace). Run at npm
 * install (scripts/postinstall.mjs → dist/install-skills-bin.js) and by the
 * desktop app's first start; `work install-skills` by hand.
 */

/** The shipped skills folder: plugins/ beside dist/ in the package (or in this repo, in dev). */
export function skillsDir(): string | null {
  const root = packageRoot();
  const dir = root ? path.join(root, 'plugins', 'work-tree', 'skills') : null;
  return dir && fs.existsSync(path.join(dir, 'work-sessions', 'SKILL.md')) ? dir : null;
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
