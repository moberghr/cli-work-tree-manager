import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { buildTimeline } from '../../../src/core/conversations/timeline.js';
import { sessionTimeline } from '../../../src/core/conversations/timeline-source.js';
import { mountTimelineRoutes } from '../../../src/server/routes/timeline-routes.js';
import { saveHistory } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { encodeProjectDir } from '../../../src/core/agents/claude/activity.js';
import type { WorktreeSession } from '../../../src/core/sessions/session-types.js';

describe('buildTimeline (pure)', () => {
  it('everything on one line, newest first; the baseline checkpoint and bad times left out; a size-only turn name said as such', () => {
    const t = buildTimeline({
      createdAt: '2026-10-01T09:00:00Z',
      archivedAt: '2026-10-02T12:00:00Z',
      prompts: [{ ts: '2026-10-01T09:05:00Z', text: 'Add a CSV export\n\nwith headers' }],
      checkpoints: [
        { id: 0, ts: '2026-10-01T09:00:00Z', label: 'Initial' },
        { id: 1, ts: '2026-10-01T09:20:00Z', label: 'CSV export added' },
        { id: 2, ts: '2026-10-01T10:00:00Z', label: '3 files · +52 −8' },
      ],
      commits: [{ repo: 'api', sha: 'abc1234def', at: '2026-10-01T10:05:00Z', subject: 'Add CSV export' }],
      prs: [{ repo: 'api', number: 7, url: 'https://github.com/x/api/pull/7', state: 'MERGED', mergedAt: '2026-10-02T11:00:00Z' }, { repo: 'api', number: 8, url: 'u', state: 'OPEN', createdAt: 'not a date' }],
    });
    expect(t.map((e) => [e.kind, e.text])).toEqual([
      ['archived', 'Archived'],
      ['pr-merged', 'Merged PR #7'],
      ['commit', 'Add CSV export'],
      ['turn', 'A turn: 3 files · +52 −8'],
      ['turn', 'CSV export added'],
      ['prompt', 'Add a CSV export with headers'],
      ['created', 'Session started'],
    ]);
  });
});

describe('sessionTimeline (real git, a transcript on disk)', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let tmp: string;
  let wt: string;
  let session: WorktreeSession;
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-')));
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    wt = path.join(tmp, 'clone');
    git(tmp, 'clone', '-q', origin, wt);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'init');
    git(wt, 'push', '-q', '-u', 'origin', 'main');
    git(wt, 'remote', 'set-head', 'origin', 'main');
    git(wt, 'checkout', '-q', '-b', 'feat/t');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'Add b');
    const now = new Date().toISOString();
    session = { target: 'api', branch: 'feat/t', isGroup: false, paths: [wt], createdAt: new Date(Date.now() - 3600_000).toISOString(), lastAccessedAt: now };
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(wt));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'c.jsonl'), JSON.stringify({ type: 'user', timestamp: now, message: { role: 'user', content: 'Add the b file' } }) + '\n');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  it('your prompts, and the commits since it left main (not main’s)', async () => {
    const t = await sessionTimeline(session);
    expect(t.filter((e) => e.kind === 'commit').map((e) => e.text)).toEqual(['Add b']);
    expect(t.find((e) => e.kind === 'prompt')?.text).toBe('Add the b file');
    expect(t.at(-1)?.kind).toBe('created');
  });

  it('with no origin/HEAD, only the commits since the session began — not the branch’s history', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('merge-base') ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' },
    );
    await sessionTimeline(session, { run: run as never });
    const log = run.mock.calls.find(([, args]) => args.includes('log'))![1];
    expect(log).toContain(`--since=${session.createdAt}`);
    expect(log).not.toContain('-n');
  });

  it('the route: 404 for an unknown session; the PR watch’s PRs included', async () => {
    saveHistory([session]);
    const app = new Hono();
    mountTimelineRoutes(app, {
      ci: () => ({ checkedAt: '', repos: [{ name: 'api', done: true, pr: { number: 3, url: 'https://github.com/x/api/pull/3', state: 'MERGED', mergedAt: new Date().toISOString(), isDraft: false, mergeStateStatus: 'CLEAN', checks: 'pass', headSha: 'x' } }] }),
    });
    const r = (await (await app.request(`/api/sessions/${sessionIdFor(session)}/timeline`)).json()) as { events: Array<{ kind: string }> };
    expect(r.events.map((e) => e.kind)).toContain('pr-merged');
    expect((await app.request('/api/sessions/nope/timeline')).status).toBe(404);
  });
});
