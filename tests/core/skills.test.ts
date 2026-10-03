import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeSkillsWith, MARKETPLACE_NAME, MARKETPLACE_REPO, PLUGIN_SPEC, type ClaudeRun } from '../../src/core/agents/claude-skills.js';
import { claudeAgent } from '../../src/core/agents/claude.js';
import { agentById } from '../../src/core/agents/index.js';
import type { AgentAdapter } from '../../src/core/agents/types.js';
import { installSkills, skillsDir } from '../../src/core/skills.js';

/** work's skills, given to each agent its own way (core/skills.ts, agents/: `skills`). Never runs a real `claude`. */

/** A `claude` CLI that answers from a script, and records what it was asked. */
function fakeClaude(answers: { version?: boolean; list?: string; add?: boolean; install?: boolean }): { run: ClaudeRun; calls: string[][] } {
  const calls: string[][] = [];
  const run: ClaudeRun = (args) => {
    calls.push(args);
    if (args[0] === '--version') return { ok: answers.version ?? true, stdout: '2.1.0' };
    if (args[1] === 'marketplace' && args[2] === 'list') return { ok: true, stdout: answers.list ?? '' };
    if (args[1] === 'marketplace' && args[2] === 'add') return { ok: answers.add ?? true, stdout: '' };
    if (args[1] === 'install') return { ok: answers.install ?? true, stdout: '' };
    return { ok: false, stdout: '' };
  };
  return { run, calls };
}

describe('Claude Code’s skills: its plugin marketplace', () => {
  it('registers the marketplace when it isn’t, then installs the plugin, user-wide', async () => {
    const { run, calls } = fakeClaude({});
    expect(await claudeSkillsWith(run).install({ skillsDir: '/x' })).toEqual({ ok: true, message: `installed the Claude Code plugin ${PLUGIN_SPEC}` });
    expect(calls).toEqual([
      ['--version'],
      ['plugin', 'marketplace', 'list'],
      ['plugin', 'marketplace', 'add', MARKETPLACE_REPO, '--scope', 'user', '--sparse', '.claude-plugin'],
      ['plugin', 'install', PLUGIN_SPEC, '--scope', 'user'],
    ]);
  });

  it('a known marketplace is not added again; an install that fails (already there) is still fine', async () => {
    const { run, calls } = fakeClaude({ list: `${MARKETPLACE_NAME}  github:${MARKETPLACE_REPO}`, install: false });
    expect(await claudeSkillsWith(run).install({ skillsDir: '/x' })).toMatchObject({ ok: true });
    expect(calls.some((c) => c[2] === 'add')).toBe(false);
  });

  it('no `claude` CLI, or a marketplace it can’t add: says so, installs nothing', async () => {
    const none = fakeClaude({ version: false });
    expect(await claudeSkillsWith(none.run).install({ skillsDir: '/x' })).toEqual({ ok: false, message: 'Claude Code (the `claude` CLI) is not installed' });
    expect(none.calls).toEqual([['--version']]);
    const refused = fakeClaude({ add: false });
    expect(await claudeSkillsWith(refused.run).install({ skillsDir: '/x' })).toMatchObject({ ok: false, message: expect.stringContaining('marketplace add') });
    expect(refused.calls.some((c) => c[1] === 'install')).toBe(false);
  });
});

describe('installSkills: every agent that takes them, each its own way', () => {
  it('the shipped skills folder is found, with both skills', () => {
    const dir = skillsDir();
    expect(dir).not.toBeNull();
    expect(fs.existsSync(path.join(dir!, 'work-sessions', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir!, 'wd-review', 'SKILL.md'))).toBe(true);
    expect(claudeAgent.skills).toBeDefined();
  });

  it('hands each the folder; an agent without skills is skipped; one that throws is reported, the rest still run', async () => {
    const got: string[] = [];
    const agent = (name: string, skills?: AgentAdapter['skills']): AgentAdapter => ({ ...agentById(name), name, ...(skills ? { skills } : {}) });
    const out = await installSkills(
      [
        agent('Echo', { install: async ({ skillsDir }) => (got.push(skillsDir), { ok: true, message: 'copied' }) }),
        agent('Plain'),
        agent('Broken', { install: async () => { throw new Error('disk full'); } }),
        agent('Late', { install: async () => ({ ok: true, message: 'linked' }) }),
      ],
      '/pkg/plugins/work-tree/skills',
    );
    expect(got).toEqual(['/pkg/plugins/work-tree/skills']);
    expect(out).toEqual([
      { agent: 'Echo', ok: true, message: 'copied' },
      { agent: 'Broken', ok: false, message: 'disk full' },
      { agent: 'Late', ok: true, message: 'linked' },
    ]);
    expect(await installSkills([agent('Echo', { install: async () => ({ ok: true, message: 'x' }) })], null)).toEqual([{ agent: 'Echo', ok: false, message: 'the skills folder was not found next to work' }]);
  });
});

describe('the skills speak to any agent', () => {
  it('no skill tells the agent it is Claude', () => {
    const dir = skillsDir()!;
    for (const name of ['work-sessions', 'wd-review']) {
      const text = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf8').replace('(Claude Code, or another agent)', '');
      expect(text, name).not.toMatch(/Claude/);
    }
  });
});
