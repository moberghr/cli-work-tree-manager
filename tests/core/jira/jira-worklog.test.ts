import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { isIssueKey, jiraStarted, jiraWorklogPoster, loggedDays, logWorkDay, quarterSeconds, worklogSettings } from '../../../src/core/jira/jira-worklog.js';
import { mountCatchUpRoutes } from '../../../src/server/routes/catch-up-routes.js';
import { saveConfig } from '../../../src/core/platform/config.js';
import { saveHistory } from '../../../src/core/sessions/history.js';
import { sessionIdFor } from '../../../src/core/sessions/session-id.js';
import { encodeProjectDir } from '../../../src/core/agents/claude/activity.js';
import { removeSession } from '../../../src/core/sessions/history.js';

const config = (w?: Record<string, unknown>) => ({ worktreesRoot: '/w', repos: {}, groups: {}, copyFiles: [], ...(w ? { jiraWorklog: w } : {}) }) as never;

describe('settings and formats', () => {
  it('needs a site, an email and a token (from JIRA_API_TOKEN by default); the site is a host name, https only', () => {
    expect(worklogSettings(config())).toBeNull();
    expect(worklogSettings(config({ site: 'acme.atlassian.net', email: 'me@acme.hr' }), {})).toBeNull();
    expect(worklogSettings(config({ site: 'https://acme.atlassian.net/jira', email: 'me@acme.hr' }), { JIRA_API_TOKEN: 't' })).toEqual({ site: 'acme.atlassian.net', email: 'me@acme.hr', token: 't' });
    expect(worklogSettings(config({ site: 'acme.atlassian.net', email: 'e', tokenEnv: 'MY_TOKEN' }), { MY_TOKEN: 'x' })?.token).toBe('x');
    expect(worklogSettings(config({ site: 'evil.com/../x?y', email: 'e', token: 't' }), {})).toMatchObject({ site: 'evil.com' });
    expect(worklogSettings(config({ site: 'a b', email: 'e', token: 't' }), {})).toBeNull();
  });
  it('issue keys, quarter hours, Jira’s started format', () => {
    expect(isIssueKey('PAY-12')).toBe(true);
    expect(isIssueKey('PAY-12/../x')).toBe(false);
    expect(quarterSeconds(61 * 60_000)).toBe(75 * 60);
    expect(jiraStarted(new Date(2026, 9, 1, 9, 0, 0))).toMatch(/^2026-10-01T09:00:00\.000[+-]\d{4}$/);
  });
});

describe('logWorkDay', () => {
  it('logs what is not logged yet for that day; never the same time twice; remembers it', async () => {
    const post = vi.fn(async () => 'w1');
    expect(await logWorkDay('s1', 'PAY-12', '2026-10-01', 50 * 60_000, post)).toMatchObject({ ok: true, logged: 3600, text: '1h logged on PAY-12 for 2026-10-01' });
    expect(post).toHaveBeenCalledWith('PAY-12', expect.objectContaining({ timeSpentSeconds: 3600, started: expect.stringMatching(/^2026-10-01T09:00/) }));
    expect(await logWorkDay('s1', 'PAY-12', '2026-10-01', 55 * 60_000, post)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('already logged') });
    expect(await logWorkDay('s1', 'PAY-12', '2026-10-01', 80 * 60_000, post)).toMatchObject({ ok: true, logged: 1800, total: 5400 });
    expect(loggedDays('s1')['2026-10-01']).toMatchObject({ issueKey: 'PAY-12', seconds: 5400, ids: ['w1', 'w1'] });
  });
  it('two calls at once (another tab, `work time --log`): only one posts; a failed post lets go of the day', async () => {
    let release!: (id: string) => void;
    const post = vi.fn(() => new Promise<string>((r) => (release = r)));
    const first = logWorkDay('s3', 'PAY-12', '2026-10-01', 60 * 60_000, post);
    expect(await logWorkDay('s3', 'PAY-12', '2026-10-01', 60 * 60_000, post)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining('being logged') });
    release('w9');
    expect(await first).toMatchObject({ ok: true, logged: 3600 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(loggedDays('s3')['2026-10-01']).toEqual({ issueKey: 'PAY-12', seconds: 3600, ids: ['w9'], at: expect.any(String) });
    // A claim left by a call that died mid-post holds for two minutes only.
    const later = new Date(Date.now() + 3 * 60_000);
    await logWorkDay('s4', 'PAY-12', '2026-10-01', 60 * 60_000, async () => { throw new Error('down'); });
    expect(await logWorkDay('s4', 'PAY-12', '2026-10-01', 60 * 60_000, async () => 'w1', later)).toMatchObject({ ok: true });
  });

  it('refused: a bad key, no work; Jira’s refusal is reported and nothing recorded', async () => {
    expect(await logWorkDay('s2', 'nope', '2026-10-01', 3600_000, vi.fn())).toMatchObject({ ok: false, status: 400 });
    expect(await logWorkDay('s2', 'PAY-1', '2026-10-01', 10_000, vi.fn())).toMatchObject({ ok: false, status: 409 });
    expect(await logWorkDay('s2', 'PAY-1', '2026-10-01', 3600_000, async () => { throw new Error('401 Unauthorized'); })).toMatchObject({ ok: false, status: 502, error: expect.stringContaining('401') });
    expect(loggedDays('s2')).toEqual({});
  });
  it('the REST call: https to the site, basic auth, JSON; the worklog id back', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: '10042' }), { status: 201 }));
    const id = await jiraWorklogPoster({ site: 'acme.atlassian.net', email: 'me@acme.hr', token: 'tok' }, fetchImpl as unknown as typeof fetch)('PAY-12', { timeSpentSeconds: 900 });
    expect(id).toBe('10042');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue/PAY-12/worklog');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('me@acme.hr:tok').toString('base64')}`);
  });
});

describe('the routes', () => {
  it('GET says whether it is set up (never the token); POST logs the latest day of its transcripts; gone with the session', async () => {
    const wt = path.join(os.homedir(), 'wt', 'api');
    fs.mkdirSync(wt, { recursive: true });
    const s = { target: 'api', branch: 'feat/w', isGroup: false, paths: [wt], createdAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), jiraKey: 'PAY-7' };
    saveHistory([s]);
    saveConfig(config({ site: 'acme.atlassian.net', email: 'me@acme.hr', token: 'secret-token' }));
    const dir = path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(wt));
    fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now() - 3600_000;
    const line = (e: object) => JSON.stringify(e) + '\n';
    fs.writeFileSync(path.join(dir, 'c.jsonl'), line({ type: 'user', timestamp: new Date(t0).toISOString(), message: { role: 'user', content: 'go' } }) + line({ type: 'assistant', timestamp: new Date(t0 + 40 * 60_000).toISOString(), message: { role: 'assistant', content: [] } }));
    const post = vi.fn(async () => 'w9');
    const app = new Hono();
    mountCatchUpRoutes(app, { ask: async () => null, postWorklog: () => post });
    const id = sessionIdFor(s);
    const g = await (await app.request(`/api/sessions/${id}/worklog`)).text();
    expect(JSON.parse(g)).toEqual({ configured: true, issueKey: 'PAY-7', logged: {} });
    expect(g).not.toContain('secret-token');
    const r = await app.request(`/api/sessions/${id}/worklog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(await r.json()).toMatchObject({ ok: true, logged: 15 * 60 }); // 40 min capped at 15 per step → 15 min
    expect(post).toHaveBeenCalledWith('PAY-7', expect.objectContaining({ timeSpentSeconds: 900 }));
    await removeSession(s.target, s.branch);
    expect(loggedDays(id)).toEqual({});
  });
});
