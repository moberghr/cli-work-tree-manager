import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ASK_EVERY_MS,
  USAGE_ASK_ARGS,
  USAGE_ASK_REQUEST,
  askClaudeUsage,
  askEnv,
  parseUsageAnswer,
  resetUsageAsks,
  type UsageAskRun,
} from '../../../../src/core/agents/claude/usage-ask.js';
import { accountOf } from '../../../../src/core/agents/claude/rate-limits.js';
import { readReadings, recordReading, usageDir } from '../../../../src/core/usage/usage-store.js';
import type { ClaudeAccount } from '../../../../src/core/agents/claude/accounts.js';

/** Claude Code 2.1.330's answer to the get_usage request (2026-11-21), its codename keys and extra_usage cut. */
const ANSWER = JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'work-usage',
    response: {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 28, resets_at: '2026-11-22T02:19:59.554245+00:00', limit_dollars: null },
        seven_day: { utilization: 7, resets_at: '2026-11-25T02:59:59.554264+00:00', limit_dollars: null },
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
        amber_ladder: null,
        extra_usage: { is_enabled: false, utilization: null, currency: 'EUR' },
        model_scoped: [{ display_name: 'Fable', utilization: 5, resets_at: '2026-11-25T02:59:59.554406+00:00' }],
      },
    },
  },
});

/** What the run prints around it: the init line first. */
const stdout = (answer = ANSWER) => `${JSON.stringify({ type: 'system', subtype: 'init' })}\n${answer}\n`;

const FABLE = {
  id: 'seven_day_model_fable',
  label: 'Weekly Fable limit',
  usedPercent: 5,
  resetsAt: '2026-11-25T02:59:59.554Z',
  asked: true,
};

describe('the get_usage request', () => {
  it('is one control request, written to a print-mode run that loads no settings, MCP servers or session', () => {
    expect(JSON.parse(USAGE_ASK_REQUEST)).toEqual({
      type: 'control_request',
      request_id: 'work-usage',
      request: { subtype: 'get_usage', skip_behaviors: true },
    });
    expect(USAGE_ASK_ARGS).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence']));
    expect(USAGE_ASK_ARGS[USAGE_ASK_ARGS.indexOf('--setting-sources') + 1]).toBe('');
    expect(USAGE_ASK_ARGS[USAGE_ASK_ARGS.indexOf('--input-format') + 1]).toBe('stream-json');
  });
});

describe('parseUsageAnswer', () => {
  it("reads the account's windows and each model's own (asked), skipping the null and codename ones", () => {
    expect(parseUsageAnswer(stdout())).toEqual([
      { id: 'five_hour', label: '5-hour limit', usedPercent: 28, resetsAt: '2026-11-22T02:19:59.554Z' },
      { id: 'seven_day', label: 'Weekly limit', usedPercent: 7, resetsAt: '2026-11-25T02:59:59.554Z' },
      FABLE,
    ]);
  });

  it('reads Opus and Sonnet weekly windows where the plan has them', () => {
    const a = JSON.parse(ANSWER) as { response: { response: { rate_limits: Record<string, unknown> } } };
    a.response.response.rate_limits.seven_day_sonnet = { utilization: 61.26, resets_at: '2026-11-25T03:00:00Z' };
    a.response.response.rate_limits.model_scoped = [];
    expect(parseUsageAnswer(stdout(JSON.stringify(a)))).toContainEqual({
      id: 'seven_day_sonnet',
      label: 'Weekly Sonnet limit',
      usedPercent: 61.3,
      resetsAt: '2026-11-25T03:00:00.000Z',
      asked: true,
    });
  });

  it('gives null for no answer, an error answer, another request’s answer, or one without rate_limits', () => {
    expect(parseUsageAnswer('')).toBeNull();
    expect(parseUsageAnswer('not json\n{"type":"control_response"')).toBeNull();
    expect(
      parseUsageAnswer(
        stdout(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: 'work-usage', error: 'Unknown' } })),
      ),
    ).toBeNull();
    expect(parseUsageAnswer(stdout(ANSWER.replace('"work-usage"', '"other"')))).toBeNull();
    expect(parseUsageAnswer(stdout(ANSWER.replace('"rate_limits"', '"limits_gone"')))).toBeNull();
  });

  it('clamps an out-of-range utilization and skips a model with no name', () => {
    const a = JSON.parse(ANSWER) as { response: { response: { rate_limits: Record<string, unknown> } } };
    a.response.response.rate_limits.model_scoped = [
      { display_name: 'Fable', utilization: 140, resets_at: null },
      { display_name: '  ', utilization: 3 },
    ];
    const ws = parseUsageAnswer(stdout(JSON.stringify(a)))!;
    expect(ws.filter((w) => w.asked)).toEqual([{ ...FABLE, usedPercent: 100, resetsAt: null }]);
  });
});

describe('askEnv', () => {
  it("takes out API keys and the parent session, and marks the run as work's own", () => {
    const env = askEnv('default', { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1' });
    expect(env.PATH).toBe('/bin');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.WORK_INTERNAL_CLAUDE).toBe('1');
  });
});

describe('askClaudeUsage', () => {
  const T0 = Date.parse('2026-11-21T12:00:00Z');
  const other = path.join(os.tmpdir(), 'claude-other-account');
  const accounts: ClaudeAccount[] = [
    { name: 'default', dir: path.join(os.homedir(), '.claude'), isDefault: true },
    { name: 'work', dir: other, isDefault: false },
  ];
  let asked: NodeJS.ProcessEnv[];
  const answers: UsageAskRun = async (env) => (asked.push(env), stdout());

  beforeEach(() => {
    fs.rmSync(usageDir(), { recursive: true, force: true });
    resetUsageAsks();
    asked = [];
  });

  it("records each signed-in account's answer under the status line's key, Fable included", async () => {
    const done = await askClaudeUsage({ now: T0, run: answers, accounts, loggedIn: () => true });
    expect(done.sort()).toEqual(['default', 'work']);
    const readings = readReadings('claude');
    expect(readings.map((r) => r.account).sort()).toEqual(['default', accountOf(other)].sort());
    for (const r of readings) expect(r.windows).toContainEqual(FABLE);
  });

  it('asks an account at most every 5 minutes, and never one that is signed out', async () => {
    await askClaudeUsage({ now: T0, run: answers, accounts, loggedIn: (d) => d !== other });
    expect(asked).toHaveLength(1);
    await askClaudeUsage({ now: T0 + ASK_EVERY_MS - 1, run: answers, accounts, loggedIn: () => true });
    expect(asked).toHaveLength(2); // only `work`, which wasn't asked
    await askClaudeUsage({ now: T0 + ASK_EVERY_MS, run: answers, accounts, loggedIn: () => true });
    expect(asked).toHaveLength(3); // `default` again
  });

  it('asks the accounts one at a time, never two Claude Codes at once', async () => {
    let running = 0;
    let most = 0;
    const slow: UsageAskRun = async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return stdout();
    };
    expect((await askClaudeUsage({ now: T0, run: slow, accounts, loggedIn: () => true })).sort()).toEqual(['default', 'work']);
    expect(most).toBe(1);
  });

  it('a run that fails or gives no answer records nothing and throws nothing', async () => {
    await expect(
      askClaudeUsage({ now: T0, run: () => Promise.reject(new Error('claude not found on PATH')), accounts, loggedIn: () => true }),
    ).resolves.toEqual([]);
    resetUsageAsks();
    await expect(askClaudeUsage({ now: T0, run: async () => 'nothing', accounts, loggedIn: () => true })).resolves.toEqual([]);
    expect(readReadings('claude')).toEqual([]);
  });

  it("the status line's next reading keeps the asked Fable window; the next answer replaces it", async () => {
    await askClaudeUsage({ now: T0, run: answers, accounts: [accounts[0]!], loggedIn: () => true });
    recordReading(
      'claude',
      'default',
      [{ id: 'five_hour', label: '5-hour limit', usedPercent: 30, resetsAt: '2026-11-22T02:19:59.554Z' }],
      T0 + 1000,
    );
    expect(readReadings('claude')[0]!.windows).toEqual([
      { id: 'five_hour', label: '5-hour limit', usedPercent: 30, resetsAt: '2026-11-22T02:19:59.554Z' },
      FABLE,
    ]);
    // Fable's window gone from the account: the next answer drops it.
    const without = ANSWER.replace(/"model_scoped":\[.*?\]/, '"model_scoped":[]');
    await askClaudeUsage({ now: T0 + ASK_EVERY_MS, run: async () => stdout(without), accounts: [accounts[0]!], loggedIn: () => true });
    expect(readReadings('claude')[0]!.windows.some((w) => w.asked)).toBe(false);
  });
});
