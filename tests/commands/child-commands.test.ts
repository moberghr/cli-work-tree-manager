import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandModule } from 'yargs';

/** `work coordinate | child | report`: a coordinating session and the sessions it starts. work web is faked. */

const calls: Array<{ method: string; route: string; body: unknown }> = [];
let answer: (route: string) => unknown = () => ({ ok: true, body: {} });
vi.mock('../../src/core/platform/web-discovery.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/platform/web-discovery.js')>()),
  callWorkWeb: vi.fn(async (method: string, route: string, body?: unknown) => {
    calls.push({ method, route, body });
    return answer(route);
  }),
}));

const { upsertSession } = await import('../../src/core/sessions/history.js');
const { sessionIdFor } = await import('../../src/core/sessions/session-id.js');
const { coordinatorMessage, coordinatorSince, parentOf, reportMessage, setCoordinator, setParent } =
  await import('../../src/core/sessions/session-children.js');
const { coordinateCommand } = await import('../../src/commands/coordinate.js');
const { childCommand } = await import('../../src/commands/child.js');
const { reportCommand } = await import('../../src/commands/report.js');

let home: string;
let main: string;
let kid: string;
const out: string[] = [];
const errors: string[] = [];
const bossId = sessionIdFor({ target: 'api', branch: 'main' });
const kidId = sessionIdFor({ target: 'api', branch: 'feat/kid' });

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-cmds-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation((m: unknown) => void out.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
  vi.spyOn(process.stdout, 'write').mockImplementation((m: unknown) => (out.push(String(m)), true));
  out.length = 0;
  errors.length = 0;
  calls.length = 0;
  answer = () => ({ ok: true, body: {} });
  main = path.join(home, 'repos', 'api');
  kid = path.join(home, 'wt', 'api', 'feat-kid');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(kid, { recursive: true });
  await upsertSession('api', false, 'main', [main]);
  await upsertSession('api', false, 'feat/kid', [kid]);
  await upsertSession('api', false, 'feat/yours', [path.join(home, 'wt', 'api', 'feat-yours')]);
  vi.spyOn(process, 'cwd').mockReturnValue(main);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const run = (cmd: CommandModule, argv: Record<string, unknown> = {}) => (cmd.handler as (argv: unknown) => unknown)({ _: [], ...argv });

describe('work coordinate', () => {
  it('grants and takes back the say-so of the session for this folder', async () => {
    await run(coordinateCommand, { on: true });
    expect(coordinatorSince(bossId)).not.toBeNull();
    expect(out.join('\n')).toContain('permission prompts still come to you');
    await run(coordinateCommand, { off: true });
    expect(coordinatorSince(bossId)).toBeNull();
  });
});

describe('work coordinate --adopt / --release', () => {
  it('adopts a session you already have (and grants), so `work child send` reaches it; release lets it go', async () => {
    await run(coordinateCommand, { adopt: ['api', 'feat/yours'] });
    const yoursId = sessionIdFor({ target: 'api', branch: 'feat/yours' });
    expect(parentOf(yoursId)?.parentId).toBe(bossId);
    expect(coordinatorSince(bossId)).not.toBeNull();
    answer = () => ({ ok: true, body: { how: 'started', sentAt: 'x' } });
    await run(childCommand, { action: 'send', target: 'api', branch: 'feat/yours', message: 'run the A/B' });
    expect(calls.map((c) => c.route)).toEqual([`/api/sessions/${yoursId}/send`]);
    await run(coordinateCommand, { release: ['api', 'feat/yours'] });
    expect(parentOf(yoursId)).toBeNull();
  });

  it('refused: one another session coordinates, one that coordinates this one, an unknown one', async () => {
    const otherId = sessionIdFor({ target: 'api', branch: 'feat/kid' });
    setParent(otherId, 'someone-else');
    await run(coordinateCommand, { adopt: ['api', 'feat/kid'] });
    expect(errors.join('\n')).toContain('another session already coordinates it');
    setParent(bossId, sessionIdFor({ target: 'api', branch: 'feat/yours' }));
    await run(coordinateCommand, { adopt: ['api', 'feat/yours'] });
    expect(errors.join('\n')).toContain('drive each other');
    await run(coordinateCommand, { adopt: ['api', 'nope'] });
    expect(errors.join('\n')).toContain('No session api nope');
  });
});

describe('work child', () => {
  it('spawn: asks work web for a new session linked to this one, with its task', async () => {
    answer = () => ({ ok: true, body: { sessionId: kidId, started: 'started' } });
    await run(childCommand, { action: 'spawn', target: 'api', branch: 'feat/new', message: 'Add the export', base: 'main' });
    expect(calls).toEqual([
      {
        method: 'POST',
        route: '/api/worktrees',
        body: { target: 'api', branch: 'feat/new', prompt: 'Add the export', parentId: bossId, base: 'main' },
      },
    ]);
    expect(process.exitCode).toBe(0);
  });

  it('spawn: work web’s refusal (no grant, too many) is said, exit 1', async () => {
    answer = () => ({ ok: false, status: 403, error: 'this session may not start sessions yet' });
    await run(childCommand, { action: 'spawn', target: 'api', branch: 'feat/new', message: 'x' });
    expect(errors.join('\n')).toContain('may not start sessions yet');
    expect(process.exitCode).toBe(1);
  });

  it('send and finish: refused for a session it did not start, and without the grant', async () => {
    setParent(kidId, bossId);
    await run(childCommand, { action: 'send', target: 'api', branch: 'feat/kid', message: 'and the tests' });
    expect(errors.join('\n')).toContain('work coordinate --on');
    setCoordinator(bossId, true);
    await run(childCommand, { action: 'finish', target: 'api', branch: 'feat/yours' });
    expect(errors.join('\n')).toContain('not started by this one');
    expect(calls).toEqual([]);
  });

  it('send and finish its own child, once granted', async () => {
    setParent(kidId, bossId);
    setCoordinator(bossId, true);
    answer = (route) => ({ ok: true, body: route.endsWith('/send') ? { how: 'typed', sentAt: 'x' } : { ok: true } });
    await run(childCommand, { action: 'send', target: 'api', branch: 'feat/kid', message: 'and the tests' });
    await run(childCommand, { action: 'finish', target: 'api', branch: 'feat/kid' });
    expect(calls.map((c) => [c.route, c.body])).toEqual([
      [`/api/sessions/${kidId}/send`, { text: coordinatorMessage('api · main', 'and the tests') }],
      [`/api/sessions/${kidId}/archive`, { archived: true }],
    ]);
    expect(out.join('\n')).toContain('archived');
  });

  it('list: its children with their state', async () => {
    setParent(kidId, bossId);
    await run(childCommand, { action: 'list', json: true });
    expect(JSON.parse(out.join(''))).toEqual([expect.objectContaining({ sessionId: kidId, branch: 'feat/kid', archived: false })]);
  });

  it('outside a session: says to run it from the coordinator’s folder', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(home, 'elsewhere'));
    await run(childCommand, { action: 'list' });
    expect(errors.join('\n')).toContain("coordinating session's folder");
    expect(process.exitCode).toBe(1);
  });
});

describe('work report', () => {
  it('a child reports to the session that started it, marked as its words', async () => {
    setParent(kidId, bossId);
    vi.spyOn(process, 'cwd').mockReturnValue(kid);
    answer = () => ({ ok: true, body: { how: 'typed', sentAt: 'x' } });
    await run(reportCommand, { message: 'Export added, tests pass.' });
    expect(calls).toEqual([
      {
        method: 'POST',
        route: `/api/sessions/${bossId}/send`,
        body: { text: reportMessage('api · feat/kid', 'Export added, tests pass.') },
      },
    ]);
  });

  it('takes no file: it runs without asking, so a file read for it would skip the repo’s deny rules', async () => {
    setParent(kidId, bossId);
    vi.spyOn(process, 'cwd').mockReturnValue(kid);
    await run(reportCommand, { file: path.join(kid, 'appsettings.Production.json') });
    await run(childCommand, { action: 'spawn', target: 'api', branch: 'feat/new', file: path.join(kid, 'secret') });
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('a session nobody started has no one to report to', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(kid);
    expect(parentOf(kidId)).toBeNull();
    await run(reportCommand, { message: 'x' });
    expect(errors.join('\n')).toContain('no one to report to');
    expect(calls).toEqual([]);
  });
});
