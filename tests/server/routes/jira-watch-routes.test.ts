import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const jira = vi.hoisted(() => ({
  available: true,
  issues: [] as Array<{ key: string; summary: string; status: string; issuetype: string; priority: string; url: string }>,
}));
vi.mock('../../../src/core/jira/jira.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/jira/jira.js')>()),
  fetchJiraPane: async () => ({ available: jira.available, issues: jira.available ? jira.issues : [] }),
  fetchMyIssues: async () => jira.issues,
}));

const { mountJiraWatchRoutes, aboutRepo, watchTargets } = await import('../../../src/server/routes/jira-watch-routes.js');
const { readDecision, saveDecision } = await import('../../../src/core/jira/jira-watch.js');

let home: string;
let app: Hono;
let events: string[];
let watch: { stop: () => void };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-routes-'));
  fs.mkdirSync(path.join(home, '.work'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  jira.available = true;
  jira.issues = [{ key: 'SD-1', summary: 'Old one', status: 'New', issuetype: 'Task', priority: 'Low', url: 'u1' }];
  events = [];
  app = new Hono();
  watch = mountJiraWatchRoutes(app, { broadcast: (e) => void events.push(e), lean: true });
});
afterEach(() => {
  watch.stop();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const req = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('Jira watch routes', () => {
  it('off by default; on records what is assigned now (and lists no baseline); off again', async () => {
    expect(await (await req('GET', '/api/jira/watch')).json()).toMatchObject({ settings: { enabled: false }, decisions: [] });
    expect((await req('PUT', '/api/jira/watch', { enabled: true })).status).toBe(200);
    expect(events).toContain('jira-watch-changed');
    expect(readDecision('SD-1')).toMatchObject({ action: 'baseline' });
    const state = await (await req('GET', '/api/jira/watch')).json();
    expect(state).toMatchObject({ settings: { enabled: true }, decisions: [] });
    expect((await req('PUT', '/api/jira/watch', { enabled: false })).status).toBe(200);
    expect(await (await req('GET', '/api/jira/watch')).json()).toMatchObject({ settings: { enabled: false, since: null } });
  });

  it("won't turn on without acli: it couldn't tell new issues from your backlog", async () => {
    jira.available = false;
    const res = await req('PUT', '/api/jira/watch', { enabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('acli') });
    expect((await req('PUT', '/api/jira/watch', { enabled: 'yes' })).status).toBe(400);
  });

  it('dismiss marks a suggestion done with; start refuses a project that is not yours', async () => {
    saveDecision({ key: 'SD-2', summary: 's', url: 'u', at: new Date().toISOString(), action: 'suggested', target: 'x', reason: 'unsure' });
    expect((await req('POST', '/api/jira/watch/SD-2/dismiss')).status).toBe(200);
    expect(readDecision('SD-2')).toMatchObject({ action: 'dismissed' });
    expect((await req('POST', '/api/jira/watch/SD-2/start', { target: 'not-a-project' })).status).toBe(400);
    expect((await req('POST', '/api/jira/watch/SD-404/dismiss')).status).toBe(404);
  });
});

describe('what the model is told about your projects', () => {
  it("each repo with its README's first real line (or package description); groups with their repos", () => {
    const a = path.join(home, 'a');
    const b = path.join(home, 'b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    fs.writeFileSync(path.join(a, 'README.md'), '# a\n\n![badge](x)\n\nThe **payments** backend for Straumur merchants.\n');
    fs.writeFileSync(path.join(b, 'package.json'), JSON.stringify({ description: 'Merchant admin frontend' }));
    expect(aboutRepo(a)).toBe('The payments backend for Straumur merchants.');
    expect(aboutRepo(b)).toBe('Merchant admin frontend');
    expect(watchTargets({ worktreesRoot: home, repos: { backend: a, frontend: b }, groups: { straumur: ['backend', 'frontend'] }, copyFiles: [] })).toEqual([
      { name: 'straumur', kind: 'group', members: ['backend', 'frontend'] },
      { name: 'backend', kind: 'repo', members: ['a'], about: 'The payments backend for Straumur merchants.' },
      { name: 'frontend', kind: 'repo', members: ['b'], about: 'Merchant admin frontend' },
    ]);
  });
});
