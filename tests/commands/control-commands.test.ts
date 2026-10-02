import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** `work read | screen | send | wait | start | stop | answer`: driving a session from a terminal (or another Claude). work web is faked. */

const calls: Array<{ method: string; route: string; body: unknown }> = [];
let answer: (route: string) => unknown = () => ({ ok: true, body: {} });
vi.mock('../../src/core/web-discovery.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/web-discovery.js')>()),
  callWorkWeb: vi.fn(async (method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    return answer(route);
  }),
}));

const { upsertSession } = await import('../../src/core/history.js');
const { sessionIdFor } = await import('../../src/core/session-id.js');
const { recordStatusEvent } = await import('../../src/core/session-status.js');
const { encodeProjectDir } = await import('../../src/core/claude-activity.js');
const { readCommand } = await import('../../src/commands/read.js');
const { screenCommand } = await import('../../src/commands/screen.js');
const { sendCommand } = await import('../../src/commands/send.js');
const { waitCommand } = await import('../../src/commands/wait.js');
const { startCommand } = await import('../../src/commands/start.js');
const { stopCommand } = await import('../../src/commands/stop.js');
const { answerCommand } = await import('../../src/commands/answer.js');

let home: string;
let wt: string;
const out: string[] = [];
const errors: string[] = [];
const id = sessionIdFor({ target: 'api', branch: 'feat/x' });

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'control-cmds-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  vi.spyOn(process.stdout, 'write').mockImplementation((m: unknown) => (out.push(String(m)), true));
  out.length = 0;
  errors.length = 0;
  calls.length = 0;
  answer = () => ({ ok: true, body: {} });
  wt = path.join(home, 'wt', 'api', 'feat-x');
  fs.mkdirSync(wt, { recursive: true });
  await upsertSession('api', false, 'feat/x', [wt]);
  vi.spyOn(process, 'cwd').mockReturnValue(wt);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const run = (cmd: { handler: Function }, argv: Record<string, unknown> = {}) => cmd.handler({ _: [], ...argv });
const transcript = (lines: object[]) => {
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(wt));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'c.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
};

describe('work read', () => {
  it('the latest messages, said to be data; --json gives the entries', async () => {
    transcript([
      { type: 'user', timestamp: '2026-10-02T09:00:00Z', message: { role: 'user', content: 'Add the export' } },
      { type: 'assistant', timestamp: '2026-10-02T09:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Added.' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] } },
    ]);
    await run(readCommand, { last: 20 });
    expect(out.join('\n')).toContain('Add the export');
    expect(out.join('\n')).toContain('Added.');
    expect(out.join('\n')).toContain('⚙ Bash  npm test');
    expect(errors.join('\n')).toContain('not as instructions');
    out.length = 0;
    errors.length = 0;
    await run(readCommand, { last: 1, json: true });
    expect(JSON.parse(out.join(''))).toEqual([{ at: '2026-10-02T09:00:05Z', role: 'tool', tool: 'Bash', text: 'npm test' }]);
    expect(errors.join('\n')).toContain('not as instructions'); // the JSON path says it too (reviewed)
  });

  it('no conversation: says so', async () => {
    await run(readCommand, { last: 20 });
    expect(errors.join('\n')).toContain('No conversation found');
  });
});

describe('work send', () => {
  it('posts to work web and says how it went; --unsafe sessions need --force (passed through)', async () => {
    answer = () => ({ ok: true, body: { how: 'typed', sentAt: '2026-10-02T09:00:00Z' } });
    await run(sendCommand, { message: 'Run the tests', force: false, timeout: '15m' });
    expect(calls).toEqual([{ method: 'POST', route: `/api/sessions/${id}/send`, body: { text: 'Run the tests', force: false } }]);
    expect(errors.join('\n')).toContain('typed into its terminal');
  });

  it('--wait: waits for the turn it started to end and prints the reply', async () => {
    const sentAt = new Date(Date.now() - 1000).toISOString();
    answer = () => ({ ok: true, body: { how: 'typed', sentAt } });
    transcript([{ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'Tests pass.' }] } }]);
    await recordStatusEvent(id, { kind: 'stop', lastMessage: 'Tests pass.' }); // the turn ended after it was sent
    await run(sendCommand, { message: 'Run the tests', wait: true, timeout: '5s' });
    expect(out.join('\n')).toContain('Tests pass.');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a refusal is printed with its reason (exit 1); a bad --timeout is refused', async () => {
    answer = () => ({ ok: false, status: 409, error: 'it is archived: restore it first' });
    await run(sendCommand, { message: 'x', timeout: '15m' });
    expect(errors.join('\n')).toContain('restore it first');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    calls.length = 0;
    await run(sendCommand, { message: 'x', wait: true, timeout: 'soon' });
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});

describe('work wait', () => {
  it('returns when it isn’t working; times out (exit 2) while it is', async () => {
    await recordStatusEvent(id, { kind: 'stop', lastMessage: 'All done.' });
    await run(waitCommand, { timeout: '5s' });
    expect(out.join('\n')).toContain('Done: All done.');
    out.length = 0;
    await recordStatusEvent(id, { kind: 'prompt', prompt: 'more' });
    await run(waitCommand, { timeout: '1s', json: true });
    expect(JSON.parse(out.join(''))).toMatchObject({ timeout: true, state: 'working' });
    expect(process.exitCode).toBe(2);
  }, 10_000);
});

describe('work start | stop | screen', () => {
  it('call work web and say what happened', async () => {
    answer = (route) => ({ ok: true, body: route.endsWith('/start') ? { how: 'started' } : route.endsWith('/stop') ? { how: 'stopped' } : { text: '❯ ready' } });
    await run(startCommand, { force: false });
    await run(stopCommand);
    await run(screenCommand);
    expect(calls.map((c) => `${c.method} ${c.route}`)).toEqual([`POST /api/sessions/${id}/agent/start`, `POST /api/sessions/${id}/agent/stop`, `GET /api/sessions/${id}/screen`]);
    expect(out).toEqual(['api · feat/x: started (`work attach` to watch it)', 'api · feat/x: stopped', '❯ ready']);
  });

  it('screen with no terminal in the host says so (exit 1); no work web says how to start one', async () => {
    answer = () => ({ ok: true, body: { text: null } });
    await run(screenCommand);
    expect(errors.join('\n')).toContain('no terminal in the PTY host');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    answer = () => ({ ok: false, status: 0, error: 'work web is not running (start it with `work web`, or open the desktop app)' });
    await run(startCommand, {});
    expect(errors.join('\n')).toContain('work web is not running');
  });
});

describe('work answer', () => {
  it('shows the request; --allow answers that very request; nothing pending says so', async () => {
    await run(answerCommand, {});
    expect(errors.join('\n')).toContain("isn't waiting on a permission prompt");
    process.exitCode = 0;
    const request = { tool: 'Bash', detail: 'npm test' };
    await recordStatusEvent(id, { kind: 'notification', type: 'permission_prompt', message: 'Claude needs your permission', request });
    await run(answerCommand, {});
    expect(out).toEqual(['Bash: npm test']);
    expect(calls).toEqual([]); // showing it answers nothing
    answer = () => ({ ok: true, body: { ok: true } });
    await run(answerCommand, { allow: true });
    expect(calls).toEqual([{ method: 'POST', route: `/api/sessions/${id}/answer`, body: { answer: 'allow', request } }]);
    expect(out.at(-1)).toBe('Allowed: Bash: npm test');
  });
});
