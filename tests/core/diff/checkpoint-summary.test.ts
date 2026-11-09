import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAgent, type AgentAdapter } from '../../../src/core/agents/index.js';
import { runInternal, runInternalReadOnly } from '../../../src/core/diff/checkpoint-summary.js';

/**
 * Internal runs go one at a time per lane: the shared lane (checkpoint names,
 * Catch me up, fork and archive summaries, the Time AI step, the Jira watch, a
 * group's instructions) and the Reviews AI step's own, which can hold its lane
 * for minutes. A review in progress never keeps anything else waiting.
 *
 * The agent is made up: a node one-liner that reads `<tag> <ms>` on stdin,
 * logs when it starts and ends, waits that long and answers its tag.
 */

let dir: string;
let log: string;
let unregister: () => void;

const SCRIPT = `
const fs = require('fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const [tag, ms] = input.trim().split(' ');
  fs.appendFileSync(process.env.LANE_LOG, 'start ' + tag + '\\n');
  setTimeout(() => {
    fs.appendFileSync(process.env.LANE_LOG, 'end ' + tag + '\\n');
    process.stdout.write(tag);
  }, Number(ms));
});
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanes-'));
  log = path.join(dir, 'log.txt');
  const run = (cwd: string) => ({ cmd: process.execPath, args: ['-e', SCRIPT], cwd, env: { ...process.env, LANE_LOG: log } });
  const fake = {
    id: 'lane-agent',
    name: 'Lane agent',
    launch: {
      tool: () => ({ cmd: 'lane-agent', baseArgs: [], resumeFlag: '', promptFileFlag: '', promptFlag: '' }),
      canResume: () => false,
      resumeLaunch: () => ({ launchPath: dir, hasConversation: false }),
      cleanEnv: (e: NodeJS.ProcessEnv) => e,
    },
    input: { submit: async () => undefined },
    instructionsFile: 'AGENTS.md',
    oneShot: {
      command: () => run(os.tmpdir()),
      readOnly: { command: ({ cwd }: { cwd: string }) => run(cwd), isSettingsFile: () => false, promptLines: [] },
    },
  } as unknown as AgentAdapter;
  unregister = registerAgent(fake);
  fs.mkdirSync(path.join(os.homedir(), '.work'), { recursive: true });
  fs.writeFileSync(
    path.join(os.homedir(), '.work', 'config.json'),
    JSON.stringify({ worktreesRoot: dir, repos: {}, groups: {}, copyFiles: [], internalAgent: 'lane-agent' }),
  );
});

afterEach(() => {
  unregister();
  fs.rmSync(path.join(os.homedir(), '.work', 'config.json'), { force: true });
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const events = () => fs.readFileSync(log, 'utf8').trim().split('\n');

describe('internal runs, one lane per kind', () => {
  it('a review in progress (its own lane) does not hold up a catch-up run (the shared lane)', async () => {
    const order: string[] = [];
    const review = runInternal('review 4000', 30_000, { lane: 'reviews' }).then((r) => (order.push('review'), r));
    // The review has started before the catch-up is asked for.
    for (let i = 0; i < 200 && !(fs.existsSync(log) && events().includes('start review')); i++) await new Promise((r) => setTimeout(r, 25));
    const catchUp = runInternal('catchup 0', 30_000).then((r) => (order.push('catchup'), r));
    expect(await catchUp).toBe('catchup');
    expect(order).toEqual(['catchup']); // done while the review still runs
    expect(await review).toBe('review');
    expect(order).toEqual(['catchup', 'review']);
  }, 60_000);

  it('the read-only review run is in the reviews lane too', async () => {
    const review = runInternalReadOnly('ro 4000', dir, 30_000, { lane: 'reviews' });
    for (let i = 0; i < 200 && !(fs.existsSync(log) && events().includes('start ro')); i++) await new Promise((r) => setTimeout(r, 25));
    expect(await runInternal('shared 0', 30_000)).toBe('shared');
    expect(events()).not.toContain('end ro');
    expect(await review).toBe('ro');
  }, 60_000);

  it('each lane is still one run at a time', async () => {
    const shared = await Promise.all([runInternal('a 300', 30_000), runInternal('b 0', 30_000)]);
    const reviews = await Promise.all([
      runInternal('c 300', 30_000, { lane: 'reviews' }),
      runInternalReadOnly('d 0', dir, 30_000, { lane: 'reviews' }),
    ]);
    expect(shared).toEqual(['a', 'b']);
    expect(reviews).toEqual(['c', 'd']);
    expect(events()).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c', 'start d', 'end d']);
  }, 60_000);

  it('a lane whose run times out lets the next one go (its tree killed)', async () => {
    const slow = runInternal('slow 60000', 1500, { lane: 'reviews' });
    const next = runInternal('next 0', 30_000, { lane: 'reviews' });
    expect(await slow).toBeNull();
    expect(await next).toBe('next');
  }, 60_000);
});
