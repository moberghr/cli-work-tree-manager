/**
 * Integration tests for `DELETE /api/sessions/:id/worktree` — the dashboard's
 * "delete session (and worktree if possible)" action. Uses a real git repo +
 * worktree under a temp HOME and `app.request()` so no port is bound.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

// The PTY pool pulls in node-pty; the route only needs its dispose hook.
const { disposePty, ensurePty, peekPty } = vi.hoisted(() => ({
  disposePty: vi.fn(),
  ensurePty: vi.fn(async () => 'ws://host/attach'),
  peekPty: vi.fn(() => false),
}));
vi.mock('../../src/core/pty-pool.js', () => ({ disposePty, ensurePty, peekPty }));

import { mountWorktreeRoutes } from '../../src/core/worktree-routes.js';
import { git } from '../../src/core/git.js';
import { loadConfig, saveConfig, type WorkConfig } from '../../src/core/config.js';
import { loadHistory, upsertSession } from '../../src/core/history.js';
import { createSingleWorktree } from '../../src/core/worktree.js';
import { sessionIdFor } from '../../src/core/web-state.js';

let tmpHome: string;
let repoDir: string;
let wtPath: string;
let app: Hono;
let broadcast: ReturnType<typeof vi.fn>;

const BRANCH = 'feat/x';

beforeEach(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'work-wr-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  vi.spyOn(console, 'log').mockImplementation(() => {});

  repoDir = path.join(tmpHome, 'repo');
  fs.mkdirSync(repoDir);
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 't@t.t'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# v1\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);

  const config: WorkConfig = {
    worktreesRoot: path.join(tmpHome, 'worktrees'),
    repos: { repo: repoDir },
    groups: {},
    copyFiles: [],
  };
  saveConfig(config);
  wtPath = path.join(config.worktreesRoot, 'repo', 'feat-x');
  expect(createSingleWorktree(repoDir, wtPath, BRANCH, config)).toBe(true);
  await upsertSession('repo', false, BRANCH, [wtPath]);

  broadcast = vi.fn();
  app = new Hono();
  mountWorktreeRoutes(app, { broadcast });
  disposePty.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function sessionId(): string {
  return sessionIdFor({
    target: 'repo',
    isGroup: false,
    branch: BRANCH,
    paths: [wtPath],
    createdAt: '',
    lastAccessedAt: '',
  });
}

async function del(body: Record<string, unknown>) {
  const res = await app.request(`/api/sessions/${sessionId()}/worktree`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe('POST /api/worktrees with a first prompt', () => {
  const create = (a: Hono, body: Record<string, unknown>) =>
    a.request('/api/worktrees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const newId = () => sessionIdFor({ target: 'repo', isGroup: false, branch: 'feat/new', paths: [], createdAt: '', lastAccessedAt: '' });
  beforeEach(() => {
    ensurePty.mockClear();
    peekPty.mockReset().mockReturnValue(false);
  });

  it('starts Claude in the PTY host with the prompt as its first message', async () => {
    const res = await create(app, { target: 'repo', branch: 'feat/new', prompt: '  Work on ABC-1: export  ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sessionId: newId(), started: 'started' });
    expect(ensurePty).toHaveBeenCalledWith(newId(), { initialPrompt: 'Work on ABC-1: export' });
  });

  it('without a prompt it only creates the worktree (as before)', async () => {
    const res = await create(app, { target: 'repo', branch: 'feat/new' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.started).toBeUndefined();
    expect(ensurePty).not.toHaveBeenCalled();
  });

  it('an already-running session gets the prompt queued for its next turn, never typed in', async () => {
    peekPty.mockReturnValue(true);
    const res = await create(app, { target: 'repo', branch: 'feat/new', prompt: 'also do X' });
    expect(await res.json()).toMatchObject({ started: 'queued' });
    expect(ensurePty).not.toHaveBeenCalled();
    const { getCommentFileStore } = await import('../../src/core/comment-file-store.js');
    expect(getCommentFileStore(newId()).snapshot()).toMatchObject([{ side: 'general', status: 'published', author: 'user', body: 'also do X' }]);
  });

  it('a start that fails still reports the created worktree', async () => {
    const failing = new Hono();
    mountWorktreeRoutes(failing, { broadcast, startSession: async () => { throw new Error('claude not found'); } });
    const res = await create(failing, { target: 'repo', branch: 'feat/new', prompt: 'go' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; startError: string; paths: string[] };
    expect(body.startError).toBe('claude not found');
    expect(fs.existsSync(body.paths[0])).toBe(true);
  });
});

describe('DELETE /api/sessions/:id/worktree', () => {
  it('removes a clean worktree and forgets the session', async () => {
    const r = await del({});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, worktreeRemoved: true });
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(loadHistory()).toHaveLength(0);
    expect(disposePty).toHaveBeenCalledWith(sessionId());
    expect(broadcast).toHaveBeenCalledWith(
      'sessions-changed',
      expect.anything(),
    );
  });

  it('refuses a dirty worktree without force, keeping the session AND its running Claude', async () => {
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'dirty\n');
    const r = await del({});
    expect(r.status).toBe(409);
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(loadHistory()).toHaveLength(1);
    // A refused delete must not have stopped the agent working in there.
    expect(disposePty).not.toHaveBeenCalled();
  });

  it('force removes a dirty worktree', async () => {
    fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'dirty\n');
    const r = await del({ force: true });
    expect(r.status).toBe(200);
    expect(fs.existsSync(wtPath)).toBe(false);
    expect(loadHistory()).toHaveLength(0);
  });

  it('sessionOnly forgets the session but leaves the worktree on disk', async () => {
    const r = await del({ sessionOnly: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, worktreeRemoved: false });
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(loadHistory()).toHaveLength(0);
  });

  it('forgets a session whose worktree is already gone from disk', async () => {
    git(['worktree', 'remove', wtPath, '--force'], repoDir);
    const r = await del({});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, worktreeRemoved: false });
    expect(loadHistory()).toHaveLength(0);
  });

  it('opens the worktree in the configured editor — a .cmd shim on Windows — with the path as one argument', async () => {
    // A fake editor that records what it was given. On Windows it is a .cmd
    // shim like the real `code.cmd`, which node's spawn refuses (EINVAL).
    const bin = path.join(tmpHome, 'bin');
    fs.mkdirSync(bin);
    const record = path.join(tmpHome, 'editor-args.txt');
    const script = path.join(bin, 'record.cjs');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(record)}, process.argv.slice(2).join('|'))`);
    const editor = process.platform === 'win32' ? path.join(bin, 'fake-editor.cmd') : path.join(bin, 'fake-editor');
    fs.writeFileSync(
      editor,
      process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      { mode: 0o755 },
    );
    saveConfig({ ...loadConfig()!, editor });

    const res = await app.request(`/api/sessions/${sessionId()}/open-editor`, { method: 'POST' });
    expect(res.status).toBe(200);
    await expect.poll(() => (fs.existsSync(record) ? fs.readFileSync(record, 'utf-8') : null), { timeout: 10_000 }).toBe(wtPath);
  });

  it('reports an editor that is not installed instead of pretending it opened', async () => {
    saveConfig({ ...loadConfig()!, editor: 'definitely-not-an-editor-xyz' });
    const res = await app.request(`/api/sessions/${sessionId()}/open-editor`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not start/);
  });

  it('404s for an unknown session', async () => {
    const res = await app.request('/api/sessions/nope/worktree', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
