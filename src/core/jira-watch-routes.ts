import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { loadHistory } from './history.js';
import { sessionIdFor } from './session-id.js';
import { setupWorktree } from './worktree.js';
import { fetchIssueDetail, fetchJiraPane, fetchMyIssues, type JiraIssue } from './jira.js';
import { jiraPrompt } from './jira-prompt.js';
import { runClaude } from './checkpoint-summary.js';
import { startSessionWithPrompt } from './worktree-routes.js';
import { collectingReporter, withReporter } from './report.js';
import {
  branchFor,
  listDecisions,
  readDecision,
  readSettings,
  saveDecision,
  setEnabled,
  sweepJira,
  type WatchDeps,
  type WatchTarget,
} from './jira-watch.js';
import type { ActivityLog } from './activity.js';
import type { JiraWatchState } from './api-types.js';

/**
 * The Jira watch's switch and decisions, for the Jira tab, and its sweep
 * (jira-watch.ts has the policy):
 *
 *   GET  /api/jira/watch              — on/off, recent decisions, the projects to start in
 *   PUT  /api/jira/watch              — {enabled}: turn it on (what's assigned now is the baseline) or off
 *   POST /api/jira/watch/:key/start   — {target}: start a suggested issue in that project
 *   POST /api/jira/watch/:key/dismiss — not this one
 */

const EVERY_MS = 5 * 60_000;

/** A line about a repo: its README's first sentence-like line, else its package.json description. */
export function aboutRepo(dir: string): string | undefined {
  try {
    const readme = ['README.md', 'readme.md', 'README'].map((n) => path.join(dir, n)).find((f) => fs.existsSync(f));
    if (readme) {
      const line = fs
        .readFileSync(readme, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.replace(/^[#>*\-\s]+/, '').replace(/[`*_[\]]/g, '').trim())
        .find((l) => l.length > 20 && !/^(!|<|http)/.test(l));
      if (line) return line.slice(0, 160);
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      const d = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as { description?: unknown }).description;
      if (typeof d === 'string' && d.trim()) return d.trim().slice(0, 160);
    }
  } catch {
    /* nothing to say */
  }
  return undefined;
}

/** Every configured repo and group, as a place an issue can go. */
export function watchTargets(cfg = loadConfig()): WatchTarget[] {
  if (!cfg) return [];
  const repos = Object.entries(cfg.repos).map(([alias, dir]): WatchTarget => ({ name: alias, kind: 'repo', members: [path.basename(dir)], about: aboutRepo(dir) }));
  const groups = Object.entries(cfg.groups).map(([name, aliases]): WatchTarget => ({ name, kind: 'group', members: aliases }));
  return [...groups, ...repos];
}

export function mountJiraWatchRoutes(
  app: Hono,
  opts: { broadcast: (event: string, data: unknown) => void; activity?: ActivityLog; lean?: boolean },
): { stop: () => void } {
  const changed = () => {
    opts.broadcast('jira-watch-changed', { ts: Date.now() });
    opts.broadcast('sessions-changed', { ts: Date.now() });
  };

  /** Create the issue's worktree and start its Claude with the issue's prompt; the session id. */
  const start = async (target: string, branch: string, issue: JiraIssue, automatic: boolean): Promise<string> => {
    const config = loadConfig();
    if (!config) throw new Error('no work config');
    const reports = collectingReporter();
    const result = await withReporter(reports, () => setupWorktree(target, branch, config, undefined, issue.key, { name: `${issue.key} ${issue.summary}`.slice(0, 120) }));
    if (!result) throw new Error(reports.errors().map((e) => e.trim()).join(' ') || `could not create ${branch} in ${target}`);
    const id = sessionIdFor({ target, branch });
    // Normal permission mode, like every session the host starts: the issue is someone else's words.
    await startSessionWithPrompt(id, jiraPrompt(issue, { automatic }));
    changed();
    return id;
  };

  let lastRunAt: string | null = null;
  let nextRunAt: string | null = null;
  let running: Promise<void> | null = null;
  const schedule = opts.lean ? null : opts.activity?.schedule('jira-watch', 'Jira watch', EVERY_MS);

  const sweep = (): Promise<void> => {
    running ??= (async () => {
      try {
        if (!readSettings().enabled) return;
        const run = opts.activity?.start('jira-watch', 'Looking for newly assigned Jira issues');
        const deps: WatchDeps = {
          fetchIssues: fetchMyIssues,
          detail: fetchIssueDetail,
          targets: () => watchTargets(),
          sessions: () => loadHistory(),
          ask: (prompt) => runClaude(prompt, 90_000),
          start: (target, branch, issue) => start(target, branch, issue, true),
          note: (text, level, sessionId) => run?.note(text, { level, ...(sessionId ? { sessionId } : {}) }),
          maxPerDay: loadConfig()?.jiraWatch?.maxPerDay,
        };
        try {
          const r = await sweepJira(deps);
          run?.done(r.started || r.suggested || r.waiting ? `${r.started} started · ${r.suggested} to start yourself${r.waiting ? ` · ${r.waiting} waiting` : ''}` : 'no new issues');
          if (r.started || r.suggested) changed();
        } catch (err) {
          run?.fail((err as Error).message);
        }
        lastRunAt = new Date().toISOString();
      } finally {
        running = null;
      }
    })();
    return running;
  };

  const tick = () => {
    nextRunAt = new Date(Date.now() + EVERY_MS).toISOString();
    schedule?.next(Date.now() + EVERY_MS);
    void sweep();
  };
  const timer = opts.lean ? null : setInterval(tick, EVERY_MS);
  timer?.unref?.();
  if (!opts.lean) {
    nextRunAt = new Date(Date.now() + EVERY_MS).toISOString();
    schedule?.next(Date.now() + EVERY_MS);
  }

  app.get('/api/jira/watch', (c) => {
    const body: JiraWatchState = {
      settings: readSettings(),
      decisions: listDecisions().filter((d) => d.action !== 'baseline').slice(0, 30),
      targets: watchTargets().map((t) => t.name),
      lastRunAt,
      nextRunAt: readSettings().enabled ? nextRunAt : null,
    };
    return c.json(body);
  });

  app.put('/api/jira/watch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== 'boolean') return c.json({ error: 'enabled (true/false) required' }, 400);
    let current: JiraIssue[] = [];
    if (body.enabled) {
      // Without the list we can't tell old from new: turning it on would start your whole backlog.
      const pane = await fetchJiraPane();
      if (!pane.available) return c.json({ error: "Jira CLI (acli) isn't available or logged in: can't tell new issues from the ones you have" }, 409);
      current = pane.issues;
    }
    const settings = setEnabled(body.enabled, current);
    opts.activity?.start('jira-watch', body.enabled ? 'Jira watch turned on' : 'Jira watch turned off').done(body.enabled ? `${current.length} issue${current.length === 1 ? '' : 's'} already assigned to you are left as they are; new ones are started` : 'no more automatic starts');
    opts.broadcast('jira-watch-changed', { ts: Date.now() });
    return c.json({ settings });
  });

  app.post('/api/jira/watch/:key/start', async (c) => {
    const key = c.req.param('key');
    const body = (await c.req.json().catch(() => null)) as { target?: unknown } | null;
    const target = typeof body?.target === 'string' ? body.target : '';
    if (!watchTargets().some((t) => t.name === target)) return c.json({ error: 'unknown project' }, 400);
    const d = readDecision(key);
    const issue = (await fetchMyIssues()).find((i) => i.key === key) ?? (d ? { key, summary: d.summary, url: d.url, status: '', issuetype: 'issue', priority: '' } : null);
    if (!issue) return c.json({ error: 'not one of your issues' }, 404);
    const branch = branchFor(issue);
    try {
      const sessionId = await start(target, branch, issue, false);
      saveDecision({ key, summary: issue.summary, url: issue.url, at: new Date().toISOString(), action: 'started', target, branch, sessionId, reason: 'started by you' });
      opts.broadcast('jira-watch-changed', { ts: Date.now() });
      return c.json({ ok: true, sessionId });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post('/api/jira/watch/:key/dismiss', (c) => {
    const d = readDecision(c.req.param('key'));
    if (!d) return c.json({ error: 'no such issue' }, 404);
    saveDecision({ ...d, action: 'dismissed', at: new Date().toISOString(), reason: 'you said not this one' });
    opts.broadcast('jira-watch-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
