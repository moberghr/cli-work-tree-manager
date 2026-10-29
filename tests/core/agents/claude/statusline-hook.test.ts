import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The hook's log lines (never its output): kept here to look at.
const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../../src/core/platform/logger.js', async (orig) => ({
  ...(await orig<typeof import('../../../../src/core/platform/logger.js')>()),
  debugLog: (_level: string, ...args: unknown[]) => void logged.push(args.join(' ')),
}));
import { runStatusLineHook } from '../../../../src/core/agents/claude/statusline-hook.js';
import { accountOf } from '../../../../src/core/agents/claude/rate-limits.js';
import { readReadings } from '../../../../src/core/usage/usage-store.js';

const input = JSON.stringify({ cwd: os.tmpdir(), rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_799_990_000 } } });

async function run(stdinText: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c));
  stdin.end(stdinText);
  await runStatusLineHook({ stdin, stdout, env });
  return Buffer.concat(chunks).toString('utf-8');
}

function setOriginal(command: string | null): void {
  const file = path.join(os.homedir(), '.work', 'statusline.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ original: command === null ? null : { type: 'command', command } }));
}

describe('runStatusLineHook', () => {
  beforeEach(() => {
    fs.rmSync(path.join(os.homedir(), '.work'), { recursive: true, force: true });
    logged.length = 0;
  });

  it('records the rate limits under the default account', async () => {
    await run(input);
    const r = readReadings('claude');
    expect(r.map((x) => x.account)).toEqual(['default']);
    expect(r[0]!.windows[0]).toMatchObject({ id: 'five_hour', usedPercent: 42 });
  });

  it("records them under the CLAUDE_CONFIG_DIR's account", async () => {
    const dir = path.join(os.tmpdir(), 'other-claude');
    await run(input, { CLAUDE_CONFIG_DIR: dir });
    expect(readReadings('claude').map((x) => x.account)).toEqual([accountOf(dir)]);
  });

  it("chains the user's own status line: its output, given the same input", async () => {
    setOriginal('cat');
    expect(await run(input)).toBe(input);
  });

  it('prints nothing without an original', async () => {
    setOriginal(null);
    expect(await run(input)).toBe('');
  });

  it("run by the user's own command (it calls the hook itself), it records but runs nothing", async () => {
    setOriginal('echo ran');
    expect(await run(input, { WORK_STATUSLINE_NESTED: '1' })).toBe('');
    expect(readReadings('claude')).toHaveLength(1);
  });

  it('decodes the input once, so a character cut between two chunks survives', async () => {
    setOriginal('cat');
    const text = JSON.stringify({ cwd: os.tmpdir(), model: { display_name: 'Opus · čćž' } });
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(Buffer.from('č')) + 1; // inside the two bytes of č
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const chunks: Buffer[] = [];
    stdout.on('data', (c: Buffer) => chunks.push(c));
    const done = runStatusLineHook({ stdin, stdout, env: {} });
    stdin.write(bytes.subarray(0, cut));
    await new Promise((r) => setTimeout(r, 20)); // read apart from the rest
    stdin.end(bytes.subarray(cut));
    await done;
    expect(Buffer.concat(chunks).toString('utf-8')).toBe(text);
  });

  it('logs the keys of rate limits it does not understand', async () => {
    await run(JSON.stringify({ rate_limits: { monthly_budget: { spent: 3 } } }));
    expect(readReadings('claude')).toEqual([]);
    expect(logged.some((l) => l.includes('rate_limits not understood') && l.includes('monthly_budget'))).toBe(true);
  });

  it('a damaged saved status line is logged, and nothing is printed', async () => {
    const file = path.join(os.homedir(), '.work', 'statusline.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken');
    expect(await run(input)).toBe('');
    expect(logged.some((l) => l.includes('saved status line unreadable'))).toBe(true);
  });

  it('records nothing for bad JSON, but still runs the original', async () => {
    setOriginal('cat');
    expect(await run('not json')).toBe('not json');
    expect(readReadings('claude')).toEqual([]);
  });
});
