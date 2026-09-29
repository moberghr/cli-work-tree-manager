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
const { disposePty } = vi.hoisted(() => ({ disposePty: vi.fn() }));
vi.mock('../../src/core/pty-pool.js', () => ({ disposePty }));

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
