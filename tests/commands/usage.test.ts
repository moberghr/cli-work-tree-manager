import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// `--restore` asks every agent: these stand in for them when set (null: the real registry).
const fake = vi.hoisted(() => ({ agents: null as null | Array<{ id: string; name: string; usage?: object }> }));
vi.mock('../../src/core/agents/index.js', async (orig) => {
  const real = await orig<typeof import('../../src/core/agents/index.js')>();
  return { ...real, knownAgents: () => fake.agents ?? real.knownAgents() };
});
import { usageCommand, usageLines } from '../../src/commands/usage.js';
import { recordReading } from '../../src/core/usage/usage-store.js';
import type { UsageWire } from '../../src/core/api-types.js';

let home: string;
let out: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cmd-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  out = '';
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void (out += a.join(' ') + '\n'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const run = (argv: Record<string, unknown>) => (usageCommand.handler as (a: unknown) => Promise<void>)({ _: [], ...argv });

describe('work usage', () => {
  it('--json prints the wire: the recorded reading and no tokens without sessions', async () => {
    recordReading('claude', 'default', [{ id: 'seven_day', label: 'Weekly limit', usedPercent: 18, resetsAt: '2999-01-01T09:00:00.000Z' }]);
    await run({ json: true });
    const w = JSON.parse(out) as UsageWire;
    expect(w.agents).toHaveLength(1);
    expect(w.agents[0]).toMatchObject({
      agent: 'claude',
      accounts: [{ account: 'default', windows: [{ id: 'seven_day', usedPercent: 18 }] }],
    });
    expect(w.tokens.week).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it('prints a table; with no reading it says how one is recorded', async () => {
    await run({});
    expect(out).toContain('no reading yet');
    expect(out).toContain('Tokens');
  });
});

describe('formatting', () => {
  it('names each account when there are several, and marks the default one', () => {
    const win = [{ id: 'five_hour', label: '5-hour limit', usedPercent: 10, resetsAt: null }];
    const w: UsageWire = {
      agents: [
        {
          agent: 'claude',
          name: 'Claude Code',
          accounts: [
            { account: 'default', at: 'x', windows: win },
            { account: 'work', isDefault: true, at: 'x', windows: win },
          ],
        },
      ],
      tokens: { today: { input: 0, cached: 0, output: 0 }, week: { input: 0, cached: 0, output: 0 }, byModel: [], topSessions: [] },
      at: 'x',
    };
    const text = usageLines(w).join('\n');
    expect(text).toContain('account default');
    expect(text).toContain('account work (default)');
    expect(text).not.toContain('account default (default)');
  });

  it('lines show each window, with its percent', () => {
    const w: UsageWire = {
      agents: [
        {
          agent: 'claude',
          name: 'Claude Code',
          accounts: [
            { account: 'default', at: 'x', windows: [{ id: 'five_hour', label: '5-hour limit', usedPercent: 42.4, resetsAt: null }] },
          ],
        },
      ],
      tokens: {
        today: { input: 1000, cached: 0, output: 0 },
        week: { input: 0, cached: 0, output: 0 },
        byModel: [],
        topSessions: [{ id: 'a', label: 'api · x', week: { input: 5, cached: 0, output: 5 } }],
      },
      at: 'x',
    };
    const text = usageLines(w).join('\n');
    expect(text).toContain('5-hour limit');
    expect(text).toContain('42%');
    expect(text).toContain('api · x');
  });

  it('a model unused today shows only its week', () => {
    const z = { input: 0, cached: 0, output: 0 };
    const w: UsageWire = {
      agents: [],
      tokens: {
        today: z,
        week: z,
        byModel: [{ model: 'opus', today: z, week: { input: 2000, cached: 0, output: 100 } }],
        topSessions: [],
      },
      at: 'x',
    };
    const line = usageLines(w).find((l) => l.includes('opus'))!;
    expect(line).toContain('this week');
    expect(line).not.toContain('today');
  });
});

describe('work usage --restore', () => {
  afterEach(() => {
    fake.agents = null;
    process.exitCode = undefined;
  });
  const agent = (name: string, r: () => Promise<{ ok: boolean; message: string }>) => ({
    id: name.toLowerCase(),
    name,
    usage: { read: () => [], restore: r },
  });

  it("prints each agent's message; a failure exits 1, the others still run", async () => {
    const calls: string[] = [];
    fake.agents = [
      agent('Alpha', async () => (calls.push('a'), { ok: true, message: 'given back' })),
      { id: 'plain', name: 'Plain' },
      agent('Beta', async () => (calls.push('b'), { ok: false, message: 'settings unreadable' })),
    ];
    await run({ restore: true });
    expect(calls).toEqual(['a', 'b']);
    expect(out).toBe(['Alpha: given back', 'Beta: settings unreadable', ''].join('\n'));
    expect(process.exitCode).toBe(1);
  });

  it('the old flag name still works', async () => {
    fake.agents = [agent('Alpha', async () => ({ ok: true, message: 'given back' }))];
    await run({ 'restore-statusline': true });
    expect(out).toBe('Alpha: given back' + '\n');
    expect(process.exitCode).toBeUndefined();
  });

  it('says so when no agent has anything to give back', async () => {
    fake.agents = [{ id: 'plain', name: 'Plain' }];
    await run({ restore: true });
    expect(out).toContain('No agent has a usage setting to give back.');
  });

  it("with the real registry, gives Claude's status line back (an isolated HOME)", async () => {
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'work hook statusline || (echo mine)' } }));
    fs.mkdirSync(path.join(home, '.work'), { recursive: true });
    fs.writeFileSync(path.join(home, '.work', 'statusline.json'), JSON.stringify({ original: { type: 'command', command: 'echo mine' } }));
    await run({ restore: true });
    expect(out).toContain('Claude Code: Your own status line is back');
    expect(JSON.parse(fs.readFileSync(settings, 'utf-8'))).toEqual({ statusLine: { type: 'command', command: 'echo mine' } });
  });
});
