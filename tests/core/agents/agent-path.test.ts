import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { agentCommands, ensureAgentPath } from '../../../src/core/agents/agent-path.js';

const SRC = path.resolve(__dirname, '../../../src');

describe('the agents found on PATH before work web or the PTY host starts any', () => {
  it("the commands come from the registry and the settings: new sessions', the assistant's, the summaries'", () => {
    expect(agentCommands({})).toEqual(['claude']);
    expect(agentCommands({ aiCommand: 'opencode --x' })).toEqual(['opencode', 'claude']);
    // A setup that doesn't run Claude anywhere doesn't look for it.
    expect(agentCommands({ aiCommand: 'opencode', assistantAgent: 'opencode', internalAgent: 'opencode' })).toEqual(['opencode']);
  });

  it('hands them to the PATH check, and never throws', () => {
    const asked: string[][] = [];
    expect(ensureAgentPath({ commands: () => ['claude'], ensure: (need) => (asked.push(need), 'added') })).toBe('added');
    expect(asked).toEqual([['claude']]);
    expect(
      ensureAgentPath({
        commands: () => {
          throw new Error('config unreadable');
        },
      }),
    ).toBe('failed');
  });

  // The wiring: removing either call left the suite green (review F007).
  it('work web calls it before it starts the PTY pool, and not for wd’s lean server', () => {
    const web = fs.readFileSync(path.join(SRC, 'commands', 'web.ts'), 'utf8');
    const call = web.indexOf('if (!lean) ensureAgentPath();');
    expect(call).toBeGreaterThan(-1);
    expect(call).toBeLessThan(web.indexOf('configurePtyPool({'));
  });

  it('the PTY host calls it once it knows it is the host, before the restore starts any session', () => {
    const host = fs.readFileSync(path.join(SRC, 'commands', 'pty-host.ts'), 'utf8');
    const call = host.indexOf('ensureAgentPath();');
    expect(call).toBeGreaterThan(host.indexOf('if (running) return null;'));
    expect(call).toBeLessThan(host.indexOf('return startPtyHost();'));
  });
});
