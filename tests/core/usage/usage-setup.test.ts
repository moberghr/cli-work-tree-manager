import { describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/core/platform/logger.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/platform/logger.js')>()),
  debugLog: (_level: string, ...args: unknown[]) => void logged.push(args.join(' ')),
}));
import { restoreAgentUsage, setupAgentUsage, type UsageAgent } from '../../../src/core/usage/usage-setup.js';

/** An agent whose setup records what it was asked. */
function recording(id: string) {
  const asked: Array<{ enabled: boolean; lean: boolean }> = [];
  const agent: UsageAgent = {
    id,
    name: id.toUpperCase(),
    usage: {
      setup: async (o) => {
        asked.push(o);
        return `${id} set up`;
      },
    },
  };
  return { agent, asked };
}

describe('setupAgentUsage (work web at start)', () => {
  it('is enabled by default and when config says nothing else', async () => {
    const a = recording('a');
    expect(await setupAgentUsage([a.agent], null, false)).toEqual([{ agent: 'a', message: 'a set up' }]);
    await setupAgentUsage([a.agent], {}, false);
    await setupAgentUsage([a.agent], { usage: { statusLine: true } }, false);
    expect(a.asked).toEqual([
      { enabled: true, lean: false },
      { enabled: true, lean: false },
      { enabled: true, lean: false },
    ]);
  });

  it('usage.statusLine: false asks each agent to give its setting back', async () => {
    const a = recording('a');
    await setupAgentUsage([a.agent], { usage: { statusLine: false } }, false);
    expect(a.asked).toEqual([{ enabled: false, lean: false }]);
  });

  it('tells a lean server so (the agent leaves its settings alone)', async () => {
    const a = recording('a');
    await setupAgentUsage([a.agent], null, true);
    expect(a.asked).toEqual([{ enabled: true, lean: true }]);
  });

  it('skips agents without a setup; one that fails is logged and the rest go on', async () => {
    const b = recording('b');
    const failing: UsageAgent = {
      id: 'x',
      name: 'X',
      usage: {
        setup: async () => {
          throw new Error('settings locked');
        },
      },
    };
    const done = await setupAgentUsage([{ id: 'plain', name: 'Plain' }, failing, b.agent], null, false);
    expect(done).toEqual([{ agent: 'b', message: 'b set up' }]);
    expect(logged.some((l) => l.includes("X's usage readings") && l.includes('settings locked'))).toBe(true);
  });

  it("with the real registry, a lean server leaves Claude's settings alone", async () => {
    const { knownAgents } = await import('../../../src/core/agents/index.js');
    const done = await setupAgentUsage(knownAgents(), null, true);
    expect(done).toEqual([{ agent: 'claude', message: 'status line left alone (lean server)' }]);
  });
});

describe('restoreAgentUsage', () => {
  it("collects each agent's outcome; a throw is that agent's failure", async () => {
    const out = await restoreAgentUsage([
      { id: 'a', name: 'A', usage: { restore: async () => ({ ok: true, message: 'back' }) } },
      { id: 'plain', name: 'Plain' },
      {
        id: 'b',
        name: 'B',
        usage: {
          restore: async () => {
            throw new Error('nope');
          },
        },
      },
    ]);
    expect(out).toEqual([
      { agent: 'a', name: 'A', ok: true, message: 'back' },
      { agent: 'b', name: 'B', ok: false, message: 'nope' },
    ]);
  });
});
