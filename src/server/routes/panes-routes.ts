import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loadConfig } from '../../core/platform/config.js';
import { DEFAULT_PROMPTS } from '../../core/sessions/saved-prompts.js';
import type { PromptsResponse } from '../../core/api-types.js';
import { fetchAllPullRequests, type PullRequestInfo } from '../../core/pr/pr.js';
import { createSharedFetch } from '../shared-fetch.js';
import type { ActivityLog } from '../../core/platform/activity.js';

/** How long the open-PR list is reused before a background refresh. */
export const PRS_TTL_MS = 120_000;
import { fetchJiraPane, type JiraIssue } from '../../core/jira/jira.js';
import {
  addTask,
  completeTask,
  editTask,
  getTasks,
  removeTask,
  uncompleteTask,
} from '../../core/tasks.js';

export interface PanesMountOptions {
  /** Server-level broadcast so mutations emit *-changed events. */
  broadcast: (event: string, data: unknown) => void;
  /** Where the PR and Jira fetches show (the Activity panel). */
  activity?: ActivityLog;
}

/**
 * Hono sub-app exposing the read endpoints and the tasks-CRUD that drive
 * the dashboard's PRs / Jira / Tasks sidebars. Mirrors the data sources
 * the TUI already uses (`core/pr.ts`, `core/jira.ts`, `core/tasks.ts`)
 * one-to-one — no new logic, just a network surface.
 */
export function mountPanesRoutes(
  app: Hono,
  opts: PanesMountOptions,
): void {
  // -- Projects ----------------------------------------------------------
  //
  // Used by the new-worktree modal's project picker. Lists configured
  // single repos and groups together; the client filters.
  // One-click prompts for the session header menu: config.json `prompts`,
  // or the built-in defaults.
  app.get('/api/prompts', (c) => {
    const configured = loadConfig()?.prompts;
    const body: PromptsResponse = { prompts: configured ?? DEFAULT_PROMPTS, configured: !!configured };
    return c.json(body);
  });

  app.get('/api/projects', (c) => {
    const config = loadConfig();
    if (!config) {
      return c.json({ singles: [], groups: [] });
    }
    const singles = Object.keys(config.repos).map((alias) => ({
      name: alias,
      kind: 'single' as const,
      path: config.repos[alias],
    }));
    const groups = Object.entries(config.groups).map(([name, aliases]) => ({
      name,
      kind: 'group' as const,
      members: aliases,
    }));
    return c.json({ singles, groups });
  });

  // -- PRs ---------------------------------------------------------------
  //
  // One `gh pr list` per repo, shared by every window and reused for two
  // minutes (shared-fetch.ts): each window asks on an interval and on every
  // sessions change, which without this spent GitHub's hourly API limit.
  const prsFetch = createSharedFetch(async (): Promise<{ prs: PullRequestInfo[]; incomplete?: string[] }> => {
    const config = loadConfig();
    if (!config) return { prs: [] };
    const run = opts.activity?.start('pr-list', 'Listing open pull requests');
    try {
      const { map, incomplete } = await fetchAllPullRequests(config.repos);
      // Flatten: one entry per PR, with the resolved repo alias attached.
      const prs = Array.from(map.values()).flat();
      if (incomplete.length) run?.note(`couldn't list every PR of ${incomplete.join(', ')} (gh failed, or 100+ open): archiving isn't suggested for sessions there`, { level: 'warn' });
      run?.done(`${prs.length} open PR${prs.length === 1 ? '' : 's'} in ${Object.keys(config.repos).length} repos`);
      // Repos gh couldn't list in full: "no PR" there means "don't know".
      return incomplete.length ? { prs, incomplete } : { prs };
    } catch (err) {
      run?.fail((err as Error).message);
      throw err;
    }
  }, PRS_TTL_MS);
  app.get('/api/prs', async (c) => {
    if (!loadConfig()) return c.json({ prs: [] });
    try {
      const result = await prsFetch.get();
      return c.json(result);
    } catch (err) {
      // gh missing or unauthenticated — surface empty rather than 500;
      // the client renders a "gh not available" hint.
      return c.json({
        prs: [],
        error: (err as Error).message,
        available: false,
      });
    }
  });

  // -- Jira --------------------------------------------------------------
  //
  // Single `acli jira auth status` probe (combined with the issue search
  // inside fetchJiraPane) — replaces the previous two-call pattern. Also
  // dedups concurrent refreshes; `acli` can be slow.
  let jiraInFlight: Promise<{ available: boolean; issues: JiraIssue[] }> | null =
    null;
  app.get('/api/jira', async (c) => {
    if (!jiraInFlight) {
      jiraInFlight = (async () => {
        const run = opts.activity?.start('jira', 'Fetching your Jira issues');
        try {
          const r = await fetchJiraPane();
          if (!r.available) run?.fail('Jira CLI (acli) not available or not logged in');
          else run?.done(`${r.issues.length} issue${r.issues.length === 1 ? '' : 's'}`);
          return r;
        } catch (err) {
          run?.fail((err as Error).message);
          throw err;
        } finally {
          jiraInFlight = null;
        }
      })();
    }
    try {
      const result = await jiraInFlight;
      return c.json(result);
    } catch (err) {
      return c.json({
        issues: [],
        available: false,
        error: (err as Error).message,
      });
    }
  });

  // -- Tasks -------------------------------------------------------------
  //
  // File-watched on the server side via the existing `tasks-changed`
  // broadcast (added below). Mutations both write through the
  // `core/tasks.ts` API and broadcast so other tabs refresh.

  app.get('/api/tasks', (c) => c.json({ tasks: getTasks() }));

  const newTaskSchema = z.object({
    text: z.string().min(1),
    link: z.string().optional(),
  });
  app.post(
    '/api/tasks',
    zValidator('json', newTaskSchema),
    async (c) => {
      const { text, link } = c.req.valid('json');
      const task = await addTask(text, link);
      opts.broadcast('tasks-changed', { id: task.id });
      return c.json({ task, tasks: getTasks() });
    },
  );

  const editSchema = z.object({
    text: z.string().min(1).optional(),
    done: z.boolean().optional(),
  });
  app.patch(
    '/api/tasks/:id',
    zValidator('json', editSchema),
    async (c) => {
      const id = Number(c.req.param('id'));
      if (!Number.isFinite(id)) {
        return c.json({ error: 'invalid id' }, 400);
      }
      const body = c.req.valid('json');
      let updated = null;
      if (typeof body.text === 'string') {
        updated = await editTask(id, body.text);
      }
      if (typeof body.done === 'boolean') {
        updated = body.done
          ? await completeTask(id)
          : await uncompleteTask(id);
      }
      if (!updated) return c.json({ error: 'not found' }, 404);
      opts.broadcast('tasks-changed', { id });
      return c.json({ task: updated, tasks: getTasks() });
    },
  );

  app.delete('/api/tasks/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'invalid id' }, 400);
    const removed = await removeTask(id);
    if (!removed) return c.json({ error: 'not found' }, 404);
    opts.broadcast('tasks-changed', { id });
    return c.json({ tasks: getTasks() });
  });
}
