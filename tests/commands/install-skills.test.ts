import { afterEach, describe, expect, it, vi } from 'vitest';

const skills = vi.hoisted(() => ({ installSkills: vi.fn() }));
vi.mock('../../src/core/skills.js', () => skills);

import { installSkillsCommand } from '../../src/commands/install-skills.js';

afterEach(() => vi.restoreAllMocks());

describe('work install-skills', () => {
  it('prints each agent’s outcome and never fails', async () => {
    skills.installSkills.mockResolvedValue([
      { agent: 'Claude Code', ok: true, message: 'installed the Claude Code plugin work-tree@moberg-plugins' },
      { agent: 'Echo', ok: false, message: 'not installed' },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await (installSkillsCommand.handler as (a: unknown) => Promise<void>)({});
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines[0]).toBe('work-tree: Claude Code: installed the Claude Code plugin work-tree@moberg-plugins');
    expect(lines[1]).toContain('work-tree: Echo: ');
    expect(lines[1]).toContain('not installed');
    expect(installSkillsCommand.describe).toBe(false); // hidden
  });
});
