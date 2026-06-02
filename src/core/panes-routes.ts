import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { fetchAllPullRequests, type PullRequestInfo } from './pr.js';
import { fetchJiraPane, type JiraIssue } from './jira.js';
import {
  addTask,
  completeTask,
  editTask,
  getTasks,
  removeTask,
  uncompleteTask,
} from './tasks.js';

export interface PanesMountOptions {
  /** Server-level broadcast so mutations emit *-changed events. */
  broadcast: (event: string, data: unknown) => void;
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
  // In-flight dedup: `gh pr list` is slow and the pane fires on a 60s
  // interval. A burst of refresh clicks (or interval + sessions-changed
  // racing) would otherwise spawn N × gh subprocesses concurrently. The
  // first concurrent request triggers the fetch; everyone else awaits
  // the same promise.
  let prsInFlight: Promise<{ prs: PullRequestInfo[] }> | null = null;
  app.get('/api/prs', async (c) => {
    const config = loadConfig();
    if (!config) return c.json({ prs: [] });
    if (!prsInFlight) {
      prsInFlight = (async () => {
        try {
          const map = await fetchAllPullRequests(config.repos);
          // Flatten: one entry per PR, with the resolved repo alias attached.
          const prs = Array.from(map.values()).flat();
          return { prs };
        } finally {
          prsInFlight = null;
        }
      })();
    }
    try {
      const result = await prsInFlight;
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
        try {
          return await fetchJiraPane();
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
