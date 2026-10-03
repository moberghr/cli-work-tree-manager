import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { git } from '../../src/core/git/git.js';
import { createSingleWorktree } from '../../src/core/worktree/worktree.js';
import { saveConfig, type WorkConfig } from '../../src/core/platform/config.js';
import { upsertSession } from '../../src/core/sessions/history.js';
import { sessionIdFor } from '../../src/core/sessions/session-id.js';
import { sessionsCommand, sessionRows } from '../../src/commands/sessions.js';
import { digestCommand, parseSince } from '../../src/commands/digest.js';
import { cleanupCommand } from '../../src/commands/cleanup.js';
import { overlapsCommand } from '../../src/commands/overlaps.js';
import type { SessionWire } from '../../src/core/api-types.js';

/**
 * The machine-readable commands Claude (and scripts) use: `work sessions`,
 * `digest`, `overlaps`, `cleanup` — thin front-ends over the same core as
 * the dashboard. Driven through their handlers against real git repos.
 */

let home: string;
let repo: string;
let wtRoot: string;
let out: string;
const DAY = 86_400_000;

const run = async (cmd: { handler: unknown }, argv: Record<string, unknown>) => {
  out = '';
  await (cmd.handler as (a: unknown) => Promise<void>)({ _: [], ...argv });
  return out;
};
const json = async <T>(cmd: { handler: unknown }, argv: Record<string, unknown>) =>
  JSON.parse(await run(cmd, { json: true, ...argv })) as T;

function worktree(branch: string, files: Record<string, string>, commit = true): string {
  const wt = path.join(wtRoot, branch.replace(/\//g, '-'));
  const config: WorkConfig = { worktreesRoot: wtRoot, repos: { repo }, groups: {}, copyFiles: [] };
  expect(createSingleWorktree(repo, wt, branch, config)).toBe(true);
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), text);
  if (commit) {
    git(['add', '.'], wt);
    git(['commit', '-q', '-m', branch, '--no-gpg-sign'], wt);
  }
  return wt;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'query-cmd-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => ((out += String(chunk)), true));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'query-repo-')));
  wtRoot = path.join(repo, '..', path.basename(repo) + '-wt');
  git(['init', '-q', '-b', 'main'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  git(['add', '.'], repo);
  git(['commit', '-q', '-m', 'init', '--no-gpg-sign'], repo);
  saveConfig({ worktreesRoot: wtRoot, repos: { repo }, groups: {}, copyFiles: [] });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const d of [home, repo, wtRoot]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('work sessions', () => {
  it('rows carry the dashboard shape plus what it shows: status label, age section, last active', () => {
    const w = (id: string, lastAccessedAt: string): SessionWire => ({
      id,
      target: 'repo',
      branch: id,
      isGroup: false,
      paths: [],
      createdAt: lastAccessedAt,
      lastAccessedAt,
      draftCount: 0,
      commentCount: 0,
      claudeCount: 0,
      ptyStatus: 'idle',
      lastActivity: null,
      activityState: 'stale',
      pendingForClaudeCount: 0,
      attention: null,
      diffStat: null,
      archivedAt: null,
      port: null,
    });
    const now = Date.now();
    const rows = sessionRows([w('old', new Date(now - 10 * DAY).toISOString()), w('today', new Date(now - 3_600_000).toISOString())], now);
    expect(rows.map((r) => [r.id, r.view.label, r.view.age])).toEqual([
      ['today', 'Idle', 'now'],
      ['old', 'Stale', 'older'],
    ]);
  });

  it('--json lists this week by default, --all adds older and archived ones; --changes adds +N −M and overlaps', async () => {
    const a = worktree('feat/a', { 'shared.ts': 'a\n' });
    const b = worktree('feat/b', { 'shared.ts': 'b\n' });
    await upsertSession('repo', false, 'feat/a', [a]);
    await upsertSession('repo', false, 'feat/b', [b]);
    const rows = await json<Array<SessionWire & { view: { age: string } }>>(sessionsCommand, { all: false, changes: true });
    expect(rows.map((r) => r.branch).sort()).toEqual(['feat/a', 'feat/b']);
    const ra = rows.find((r) => r.branch === 'feat/a')!;
    expect(ra.view.age).toBe('now');
    expect(ra.overlaps?.map((o) => [o.branch, o.files])).toEqual([['feat/b', [{ repo: 'repo', path: 'shared.ts' }]]]);
  }, 60_000);
});

describe('work overlaps', () => {
  it('--json maps each session to the others changing its files', async () => {
    await upsertSession('repo', false, 'feat/a', [worktree('feat/a', { 'x.ts': '1\n' })]);
    await upsertSession('repo', false, 'feat/b', [worktree('feat/b', { 'x.ts': '2\n' })]);
    await upsertSession('repo', false, 'feat/c', [worktree('feat/c', { 'other.ts': '3\n' })]);
    const o = await json<Record<string, Array<{ branch: string }>>>(overlapsCommand, {});
    expect(o[sessionIdFor({ target: 'repo', branch: 'feat/a' })].map((x) => x.branch)).toEqual(['feat/b']);
    expect(o[sessionIdFor({ target: 'repo', branch: 'feat/c' })]).toBeUndefined();
  }, 60_000);
});

describe('work digest', () => {
  it('--since: today, yesterday, week, or a date', () => {
    const now = new Date(2026, 8, 29, 15);
    expect(parseSince(undefined, now)).toEqual({ since: new Date(2026, 8, 29), title: 'Today' });
    expect(parseSince('week', now).title).toBe('Last 7 days');
    expect(parseSince('2026-09-01', now).since.getTime()).toBe(Date.parse('2026-09-01'));
    expect(() => parseSince('soonish', now)).toThrow(/--since/);
  });

  it('with no work web running it builds the digest from disk', async () => {
    const d = await json<{ since: string; sessions: unknown[] }>(digestCommand, { since: 'today' });
    expect(Array.isArray(d.sessions)).toBe(true);
    expect(Date.parse(d.since)).toBeGreaterThan(Date.now() - 2 * DAY);
  });
});

describe('work cleanup', () => {
  it('lists what can go (--json), removes it with --apply, and refuses work of its own', async () => {
    const merged = worktree('feat/merged', { 'm.ts': 'm\n' });
    git(['merge', '-q', '--no-ff', '--no-gpg-sign', '-m', 'merge', 'feat/merged'], repo);
    const work = worktree('feat/work', { 'w.ts': 'w\n' });
    // Sessions quiet for 10 days, so the one-day idle rule doesn't apply.
    const old = new Date(Date.now() - 10 * DAY).toISOString();
    await upsertSession('repo', false, 'feat/merged', [merged]);
    await upsertSession('repo', false, 'feat/work', [work]);
    const { withDb } = await import('../../src/core/platform/db.js');
    withDb((d) => {
      for (const row of d.prepare('SELECT target, branch, data FROM sessions').all() as Array<{
        target: string;
        branch: string;
        data: string;
      }>) {
        const s = JSON.parse(row.data);
        d.prepare('UPDATE sessions SET data = ? WHERE target = ? AND branch = ?').run(
          JSON.stringify({ ...s, lastAccessedAt: old }),
          row.target,
          row.branch,
        );
      }
    });

    const scan = await json<{ candidates: Array<{ sessionId: string; branch: string; verdict: string; suggested: string | null }> }>(
      cleanupCommand,
      { fetch: false },
    );
    const byBranch = Object.fromEntries(scan.candidates.map((c) => [c.branch, c]));
    expect(byBranch['feat/merged']).toMatchObject({ verdict: 'merged', suggested: 'delete' });
    expect(byBranch['feat/work']).toMatchObject({ verdict: 'work', suggested: 'archive' });

    const results = await json<Array<{ ok: boolean; message: string }>>(cleanupCommand, {
      apply: true,
      ids: [byBranch['feat/merged'].sessionId, byBranch['feat/work'].sessionId],
      action: 'delete',
      force: false,
    });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1].message).toMatch(/^Not removed: 1 commit not in main/);
    expect(fs.existsSync(merged)).toBe(false);
    expect(fs.existsSync(work)).toBe(true);
    expect(process.exitCode).toBe(1); // one was refused
  }, 90_000);
});
