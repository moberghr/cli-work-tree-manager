import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { computeDiff } from './diff-pipeline.js';
import { resolveRepoDiff } from './diff-scope.js';
import { loadHistory, type WorktreeSession } from './history.js';
import {
  disposeAllWatchers,
  findSession,
  sessionIdFor,
  subscribeSession,
} from './web-state.js';
import { readSessionMeta } from './session-meta.js';
import { claudeProjectsRoot } from './claude-activity.js';
import { createFsWatcher } from './fs-watcher.js';
import { mountSessionCommentRoutes } from './session-comment-routes.js';
import { mountPanesRoutes } from './panes-routes.js';
import { mountWorktreeRoutes } from './worktree-routes.js';
import { mountScopeRoutes } from './scope-routes.js';
import { mountTerminalRoutes } from './terminal-routes.js';
import { disposeAllScopes, listScopes } from './scope-manager.js';
import { clearCheckpoints } from './checkpoint.js';
import { attachTerminalWs } from './terminal-ws.js';
import { disposeAllPtys } from './pty-pool.js';
import { resolveWebRoot } from './web-static.js';
import { serveSpa } from './spa-handler.js';
import { launch, type DiffServerHandle, type SseEvent } from './diff-server.js';
import type { ParsedFile } from './diff-parse.js';

export type WebServerHandle = DiffServerHandle;

function sessionToWire(s: WorktreeSession) {
  const id = sessionIdFor(s);
  const meta = readSessionMeta(id, s);
  return {
    id,
    target: s.target,
    branch: s.branch,
    isGroup: s.isGroup,
    paths: s.paths,
    baseBranch: s.baseBranch,
    jiraKey: s.jiraKey,
    createdAt: s.createdAt,
    lastAccessedAt: s.lastAccessedAt,
    draftCount: meta.draftCount,
    commentCount: meta.commentCount,
    claudeCount: meta.claudeCount,
    ptyStatus: meta.ptyStatus,
    lastActivity: meta.lastActivity,
    activityState: meta.activityState,
    pendingForClaudeCount: meta.pendingForClaudeCount,
  };
}

export interface RepoData {
  name: string;
  root: string;
  files: ParsedFile[];
  /** Per-repo resolved parent for branch-mode diffs. `HEAD` for uncommitted. */
  resolvedBase: string;
}

export type DiffBase = 'uncommitted' | 'branch';

interface SessionDiffResult {
  repos: RepoData[];
  /** Primary repo's resolved parent — used for the single-line "vs X"
   *  badge. For groups this is `paths[0]`'s parent. */
  resolvedBase: string;
}

/**
 * Compute the diff for a session under one of two scopes:
 *   - 'uncommitted' — `git diff HEAD` (default). Just the working-tree
 *     deltas — what's not committed yet.
 *   - 'branch' — everything since this worktree was forked. Uses the
 *     session's recorded `baseBranch` when known, falls back to
 *     auto-detection against main/master/dev/develop.
 *
 * Per-repo `resolvedBase` is included on each entry so the UI can label
 * per-repo if it wants to (groups may have different parents per repo).
 */
function computeSessionDiff(s: WorktreeSession, base: DiffBase): SessionDiffResult {
  const resolved = s.paths.map((p) => resolveRepoDiff(p, base, s.baseBranch));
  const repos = s.paths.map((p, i) => ({
    name: path.basename(p),
    root: p,
    resolvedBase: resolved[i].resolvedBase,
    files: computeDiff({ root: p, diffArg: resolved[i].diffArg }),
  }));
  return { repos, resolvedBase: resolved[0]?.resolvedBase ?? 'HEAD' };
}

export async function startWebServer(): Promise<WebServerHandle> {
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    throw new Error(
      'Could not find dist/web/. Run `npm run build:web` (or `npm run build`) first.',
    );
  }

  const sseListeners = new Set<(e: SseEvent) => void>();
  const broadcast = (event: string, data: unknown) => {
    for (const cb of sseListeners) cb({ event, data });
  };

  // Watch ~/.work/history.json so the sidebar reflects worktrees created
  // (or removed) by other terminals in real time.
  const home = os.homedir();
  const historyPath = path.join(home, '.work', 'history.json');
  const onHistoryChange = () =>
    broadcast('sessions-changed', { ts: Date.now() });
  fs.watchFile(historyPath, { interval: 1000 }, onHistoryChange);

  // Same idea for tasks — `work todo add` from a separate terminal
  // should refresh the dashboard's Tasks pane without a manual reload.
  const tasksPath = path.join(home, '.work', 'tasks.json');
  const onTasksChange = () => broadcast('tasks-changed', { ts: Date.now() });
  fs.watchFile(tasksPath, { interval: 1000 }, onTasksChange);

  // Watch Claude's per-project transcripts so the dashboard sees external
  // terminals coming alive. Claude writes constantly while it's thinking;
  // the watcher debounces to 250 ms so we don't spam the sidebar 100×/s
  // mid-turn. The same broadcast also covers our own PTYs writing here.
  const projectsRoot = claudeProjectsRoot();
  let activityWatcher: { stop(): void } | null = null;
  try {
    if (fs.existsSync(projectsRoot)) {
      activityWatcher = createFsWatcher({
        roots: [projectsRoot],
        debounceMs: 250,
        onChange: () => broadcast('sessions-changed', { ts: Date.now() }),
      });
    }
  } catch { /* watcher startup is best-effort */ }

  // Decay tick: even when nothing writes, sessions transition active → open
  // → stale purely by elapsed time. Re-broadcast every 10 s so the badges
  // catch up. Cheap — the client just refetches /api/sessions.
  const decayTick = setInterval(
    () => broadcast('sessions-changed', { ts: Date.now() }),
    10_000,
  );

  const app = new Hono();

  app.get('/api/context', (c) => c.json({ mode: 'dashboard' }));

  app.get('/api/sessions', (c) =>
    c.json({ sessions: loadHistory().map(sessionToWire) }),
  );

  app.get('/api/sessions/:id/diff', (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const baseParam = c.req.query('base') ?? 'uncommitted';
    const base: DiffBase =
      baseParam === 'branch' ? 'branch' : 'uncommitted';
    try {
      const { repos, resolvedBase } = computeSessionDiff(session, base);
      return c.json({ sessionId: id, base, resolvedBase, repos });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Per-session comments (file-backed). Emits comments-changed via broadcast.
  mountSessionCommentRoutes(app, { broadcast });

  // PRs / Jira / Tasks read endpoints + tasks CRUD. Emits tasks-changed.
  mountPanesRoutes(app, { broadcast });

  // Worktree mutations (create/remove/sync/rebase/open-editor). Each
  // emits sessions-changed so the sidebar refreshes.
  mountWorktreeRoutes(app, { broadcast });

  // Ad-hoc scopes registered by `wd` invocations — gives the dashboard
  // an addressable URL per scope (/diff/<hash>, /review/<hash>) so we
  // can collapse the standalone wd-server/wd -c daemons into this
  // single process.
  mountScopeRoutes(app, { broadcast });

  // PTY upgrade endpoint. Returns a noop response — the upgrade is handled
  // by the server's `upgrade` event below.
  mountTerminalRoutes(app);

  app.get('/events', (c) => {
    const wantedSession = c.req.query('session');
    return streamSSE(c, async (stream) => {
      const listener = (e: SseEvent) => {
        stream
          .writeSSE({ event: e.event, data: JSON.stringify(e.data) })
          .catch(() => { /* */ });
      };
      sseListeners.add(listener);
      await stream.writeSSE({ event: 'connected', data: '' });

      let unsubscribe: (() => void) | null = null;
      if (wantedSession) {
        unsubscribe = subscribeSession(wantedSession, () => {
          stream
            .writeSSE({
              event: 'diff-changed',
              data: JSON.stringify({ sessionId: wantedSession }),
            })
            .catch(() => { /* */ });
        });
      }
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          sseListeners.delete(listener);
          if (unsubscribe) unsubscribe();
          resolve();
        });
      });
    });
  });

  // SPA fallback last.
  app.get('*', (c) => serveSpa(c, webRoot));

  const handle = await launch(app);
  const wsBridge = attachTerminalWs(handle.httpServer, handle.port);
  process.stderr.write(chalk.gray(`[web] dashboard at ${handle.url}\n`));

  return {
    url: handle.url,
    port: handle.port,
    stop: async () => {
      fs.unwatchFile(historyPath, onHistoryChange);
      fs.unwatchFile(tasksPath, onTasksChange);
      clearInterval(decayTick);
      activityWatcher?.stop();
      disposeAllWatchers();
      // Sweep checkpoint refs + manifests for every active scope BEFORE
      // wiping the registry — otherwise `refs/wd/<hash>/*` refs leak
      // across `work web` restarts and accumulate without bound in
      // every repo the user has reviewed.
      for (const scope of listScopes()) {
        try {
          clearCheckpoints(scope.hash, scope.paths);
        } catch {
          // Best-effort — partial cleanup is fine, log only matters for
          // diagnosis and doesn't change the shutdown outcome.
        }
      }
      disposeAllScopes();
      disposeAllPtys();
      wsBridge.close();
      await handle.stop();
    },
  };
}
