/**
 * Integration tests for the scope-routes range/checkpoint endpoints.
 * Mounts the sub-app on a fresh Hono instance and exercises the new
 * `?from=&to=` modes plus `GET /api/scopes/:hash/checkpoints`. Uses
 * `app.request()` so no real port is bound.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { mountScopeRoutes } from '../../src/core/scope-routes.js';
import { disposeAllScopes } from '../../src/core/scope-manager.js';
import { git } from '../../src/core/git.js';
import { takeCheckpoint, loadManifest } from '../../src/core/checkpoint.js';

// Stub the lazy Claude summary so checkpoint naming never spawns `claude -p`
// during tests. ensureSummary still runs (and persists the label), just with
// a deterministic, instant result.
vi.mock('../../src/core/checkpoint-summary.js', () => ({
  summarizeCheckpoint: vi.fn(async () => 'mock summary'),
}));

let tmpHome: string;
let repoDir: string;
let app: Hono;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'work-sr-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

  repoDir = path.join(tmpHome, 'repo');
  fs.mkdirSync(repoDir);
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 't@t.t'], repoDir);
  git(['config', 'user.name', 'Test'], repoDir);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# v1\n');
  git(['add', '.'], repoDir);
  git(['commit', '-m', 'init', '--no-gpg-sign'], repoDir);

  app = new Hono();
  mountScopeRoutes(app, { broadcast: () => { /* */ } });
});

afterEach(() => {
  disposeAllScopes();
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function register(label = 'test'): Promise<string> {
  const res = await app.request('/api/scopes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [repoDir], label }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { hash: string }).hash;
}

describe('GET /api/scopes/:hash/checkpoints', () => {
  it('returns empty entries before any snapshot is taken', async () => {
    const hash = await register();
    const res = await app.request(
      `/api/scopes/${hash}/checkpoints`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('returns 404 for an unknown scope', async () => {
    const res = await app.request('/api/scopes/nope/checkpoints');
    expect(res.status).toBe(404);
  });
});

describe('per-instruction checkpoints (/api/checkpoint + /seal)', () => {
  /** Poll the checkpoints endpoint until at least `n` entries exist. The
   *  Initial snapshot is taken fire-and-forget by register, so we must wait
   *  for it before driving the Stop-hook route (otherwise the first POST
   *  would itself create the Initial entry and skew the ids). */
  async function waitForEntries(hash: string, n: number): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const res = await app.request(`/api/scopes/${hash}/checkpoints`);
      const body = (await res.json()) as { entries: unknown[] };
      if (body.entries.length >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${n} checkpoint(s)`);
  }

  const checkpoint = (cwd: string) =>
    app.request('/api/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
  const seal = (cwd: string) =>
    app.request('/api/checkpoint/seal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });

  it('refreshes the live step across turns and opens a fresh one after a prompt', async () => {
    const hash = await register();
    await waitForEntries(hash, 1); // Initial #0

    // Turn 1 of instruction A → opens step #1.
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'turn 1\n');
    expect((await (await checkpoint(repoDir)).json()).snapshotted).toBe(1);
    let m = loadManifest(hash);
    expect(m.entries).toHaveLength(2);
    const idAfterTurn1 = m.entries[1].id;
    const shaAfterTurn1 = m.entries[1].repos[repoDir];

    // Turn 2 of the SAME instruction → refreshes step #1, does NOT append.
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'turn 1\nturn 2\n');
    await checkpoint(repoDir);
    m = loadManifest(hash);
    expect(m.entries).toHaveLength(2); // still two — no per-turn proliferation
    expect(m.entries[1].id).toBe(idAfterTurn1);
    expect(m.entries[1].repos[repoDir]).not.toBe(shaAfterTurn1); // content moved

    // New user prompt seals the live step.
    expect((await (await seal(repoDir)).json()).sealed).toBe(1);

    // Instruction B → opens a brand-new step #2.
    fs.writeFileSync(path.join(repoDir, 'b.txt'), 'instruction B\n');
    await checkpoint(repoDir);
    m = loadManifest(hash);
    expect(m.entries).toHaveLength(3);
    expect(m.entries[2].id).toBe(idAfterTurn1 + 1);
  });

  it('seal is a no-op for an untracked cwd', async () => {
    const res = await seal(path.join(tmpHome, 'not', 'a', 'scope'));
    expect(res.status).toBe(200);
    expect((await res.json()).sealed).toBe(0);
  });
});

describe('GET /api/scopes/:hash/diff range mode', () => {
  it('rejects from=working with 400', async () => {
    const hash = await register();
    const res = await app.request(
      `/api/scopes/${hash}/diff?from=working&to=working`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('from-checkpoint');
  });

  it('rejects an unknown from id with 400', async () => {
    const hash = await register();
    const res = await app.request(
      `/api/scopes/${hash}/diff?from=999&to=working`,
    );
    expect(res.status).toBe(400);
  });

  it('rejects a reversed range (to < from) with 400', async () => {
    const hash = await register();
    // Need two real checkpoints to exercise a reversed range.
    await takeCheckpoint(hash, [{ name: repoDir, root: repoDir }]);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# v2\n');
    await takeCheckpoint(hash, [{ name: repoDir, root: repoDir }]);

    const res = await app.request(
      `/api/scopes/${hash}/diff?from=1&to=0`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/must be >=/);
  });

  it('returns a range diff when both endpoints are valid', async () => {
    const hash = await register();
    await takeCheckpoint(hash, [{ name: repoDir, root: repoDir }]);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# v2\n');
    await takeCheckpoint(hash, [{ name: repoDir, root: repoDir }]);

    const res = await app.request(
      `/api/scopes/${hash}/diff?from=0&to=1`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: number;
      to: number | string;
      repos: { name: string; files: unknown[] }[];
    };
    expect(body.from).toBe(0);
    expect(body.to).toBe(1);
    expect(body.repos[0].files.length).toBeGreaterThan(0);
  });

  it('returns a range diff with to=working', async () => {
    const hash = await register();
    await takeCheckpoint(hash, [{ name: repoDir, root: repoDir }]);
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# v2\n');

    const res = await app.request(
      `/api/scopes/${hash}/diff?from=0&to=working`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { to: string | number };
    expect(body.to).toBe('working');
  });

  it('falls back to legacy diff (HEAD vs working) when no range params', async () => {
    const hash = await register();
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# changed\n');

    const res = await app.request(`/api/scopes/${hash}/diff`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedBase: string;
      repos: { files: unknown[] }[];
    };
    expect(body.resolvedBase).toBe('HEAD');
    expect(body.repos[0].files.length).toBeGreaterThan(0);
  });
});

describe('re-registering an ended scope (fresh `wd -c` run)', () => {
  it('resets `ended` and clears the previous review comments', async () => {
    const hash = await register();

    // Run 1: post a comment, then End Review.
    let res = await app.request(`/api/scopes/${hash}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'old comment' }),
    });
    expect(res.status).toBe(200);
    res = await app.request(`/api/scopes/${hash}/done`, { method: 'POST' });
    expect(res.status).toBe(200);

    // The CLI poll shape after run 1: old comment present + ended.
    res = await app.request(`/api/scopes/${hash}/comments`);
    let body = (await res.json()) as { comments: unknown[]; ended?: boolean };
    expect(body.ended).toBe(true);
    expect(body.comments).toHaveLength(1);

    // Run 2: `wd -c` re-registers the same paths → same hash, fresh review.
    const hash2 = await register();
    expect(hash2).toBe(hash);

    res = await app.request(`/api/scopes/${hash}/comments`);
    body = (await res.json()) as { comments: unknown[]; ended?: boolean };
    expect(body.ended).toBe(false);
    expect(body.comments).toHaveLength(0);
  });

  it('does not clear comments when re-registering a live (not ended) scope', async () => {
    const hash = await register();
    let res = await app.request(`/api/scopes/${hash}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'still relevant' }),
    });
    expect(res.status).toBe(200);

    const hash2 = await register();
    expect(hash2).toBe(hash);

    res = await app.request(`/api/scopes/${hash}/comments`);
    const body = (await res.json()) as { comments: unknown[]; ended?: boolean };
    expect(body.ended).toBe(false);
    expect(body.comments).toHaveLength(1);
  });
});

describe('re-baseline on branch advance', () => {
  /** Poll until the manifest's Initial (id 0) entry baselines `expectedTree`
   *  (its commit's tree sha). The re-baseline is fire-and-forget. */
  async function waitForInitialTree(
    hash: string,
    expectedTree: string,
  ): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const m = loadManifest(hash);
      const initial = m.entries.find((e) => e.id === 0);
      if (initial) {
        const sha = initial.repos[repoDir];
        const tree = sha
          ? git(['rev-parse', `${sha}^{tree}`], repoDir).stdout.trim()
          : '';
        if (tree === expectedTree) return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting for re-baselined Initial');
  }

  it('drops stale history and re-baselines when HEAD advanced since the baseline', async () => {
    const hash = await register();
    // Wait for the first Initial.
    await waitForInitialTree(
      hash,
      git(['rev-parse', 'HEAD^{tree}'], repoDir).stdout.trim(),
    );

    // Accumulate a working-tree checkpoint so there's history to drop.
    fs.writeFileSync(path.join(repoDir, 'work.txt'), 'session work\n');
    await app.request('/api/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repoDir }),
    });
    expect(loadManifest(hash).entries.length).toBeGreaterThanOrEqual(2);

    // The branch advances (simulating a `git pull`/merge of upstream work).
    fs.writeFileSync(path.join(repoDir, 'upstream.txt'), 'merged in\n');
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'advance branch', '--no-gpg-sign'], repoDir);
    const newHeadTree = git(['rev-parse', 'HEAD^{tree}'], repoDir).stdout.trim();

    // Re-register (a fresh `wd` in the same worktree, same hash).
    const hash2 = await register();
    expect(hash2).toBe(hash);

    // The stale baseline + history are dropped; Initial now baselines the
    // new HEAD, so "Initial → working" tracks only this session's work.
    await waitForInitialTree(hash, newHeadTree);
    const m = loadManifest(hash);
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].id).toBe(0);
    expect(m.entries[0].label).toBe('Initial');
  });

  it('resets to a fresh baseline when a commit lands between turns (Stop-hook path)', async () => {
    const hash = await register();
    await waitForInitialTree(
      hash,
      git(['rev-parse', 'HEAD^{tree}'], repoDir).stdout.trim(),
    );

    // Uncommitted work → a Stop-hook checkpoint opens step #1.
    fs.writeFileSync(path.join(repoDir, 'wip.txt'), 'work in progress\n');
    await app.request('/api/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repoDir }),
    });
    expect(loadManifest(hash).entries).toHaveLength(2);

    // The work gets committed (HEAD advances, working tree goes clean).
    git(['add', '.'], repoDir);
    git(['commit', '-m', 'ship wip', '--no-gpg-sign'], repoDir);
    const newHeadTree = git(['rev-parse', 'HEAD^{tree}'], repoDir).stdout.trim();

    // The next turn's Stop hook re-baselines: the strip resets to just the
    // Initial baseline at the new HEAD (no leftover step, tree is clean).
    await app.request('/api/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repoDir }),
    });
    const m = loadManifest(hash);
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].id).toBe(0);
    const initTree = git(
      ['rev-parse', `${m.entries[0].repos[repoDir]}^{tree}`],
      repoDir,
    ).stdout.trim();
    expect(initTree).toBe(newHeadTree);
  });

  it('leaves the baseline alone when only uncommitted edits exist (no HEAD move)', async () => {
    const hash = await register();
    await waitForInitialTree(
      hash,
      git(['rev-parse', 'HEAD^{tree}'], repoDir).stdout.trim(),
    );
    fs.writeFileSync(path.join(repoDir, 'work.txt'), 'session work\n');
    await app.request('/api/checkpoint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: repoDir }),
    });
    const before = loadManifest(hash).entries.length;
    expect(before).toBeGreaterThanOrEqual(2);

    // Re-register with a dirty-but-not-advanced worktree → history preserved.
    await register();
    // Give any (incorrect) async re-baseline a chance to run.
    await new Promise((r) => setTimeout(r, 100));
    expect(loadManifest(hash).entries.length).toBe(before);
  });
});
