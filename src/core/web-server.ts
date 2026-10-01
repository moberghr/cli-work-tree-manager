import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { computeDiff } from './diff-pipeline.js';
import { resolveRepoDiff } from './diff-scope.js';
import { loadHistory, type WorktreeSession } from './history.js';
import {
  disposeAllWatchers,
  disposeSessionWatcher,
  findSession,
  subscribeSession,
} from './web-state.js';
import { claudeProjectsRoot } from './claude-activity.js';
import { createFsWatcher } from './fs-watcher.js';
import { mountSessionCommentRoutes } from './session-comment-routes.js';
import { mountPanesRoutes } from './panes-routes.js';
import { mountWorktreeRoutes } from './worktree-routes.js';
import { mountScopeRoutes } from './scope-routes.js';
import { mountTerminalRoutes } from './terminal-routes.js';
import { mountStatusRoutes } from './status-routes.js';
import { mountShipRoutes } from './ship-routes.js';
import { mountChatRoutes } from './chat-routes.js';
import { mountSessionOrderRoutes } from './session-order-routes.js';
import { archiveSession } from './session-archive.js';
import { defaultArchiveDeps } from './session-archive-deps.js';
import { claudeSessionsDir, claudesBySession, readLiveClaudes, summarizeClaudes } from './live-claudes.js';
import { branchCheckedOut, shadowedSessions } from './shared-folders.js';
import { sessionIdFor } from './session-id.js';
import { DiffStatCache, wantsDiffStat } from './diff-stat.js';
import { findOverlaps } from './overlap.js';
import { buildStamp } from './build-stamp.js';
import { reviewThreadsOf, sessionWire } from './session-wire.js';
import { createDigestSource } from './digest-source.js';
import { report } from './report.js';
import { mountCleanupRoutes } from './cleanup-routes.js';
import { mountAssistantRoutes } from './assistant-routes.js';
import type { ActivityWire, DigestResponse, SessionWire } from './api-types.js';
import { createActivityLog } from './activity.js';
import { recentProcessTable } from './process.js';
import { throttleTrailing } from './throttle.js';
import { mountPrReplyRoutes } from './pr-reply-routes.js';
import { applyArchiveRetention } from './archive-retention.js';
import { draftCounts } from './pr-replies.js';
import { bestEffort } from './best-effort.js';
import { loadManifest } from './checkpoint.js';
import { mountRevertRoutes } from './revert-routes.js';
import { mountDevRoutes } from './dev-routes.js';
import { mountCiRoutes } from './ci-routes.js';
import { sweepOldDiffArtifacts } from './diffs-sweep.js';
import { revision } from './db.js';
import { disposeAllScopes, findScope, listScopes, registerScope, scopeHashForPaths, scopesToSweep } from './scope-manager.js';
import { clearCheckpoints } from './checkpoint.js';
import { attachTerminalWs } from './terminal-ws.js';
import { detachPtyPool, disposePty, initPtyPool, listHostPtys, ptyPids } from './pty-pool.js';
import { DEFAULT_SLEEP_AFTER_MINUTES, sleepAfterMs, sleepCandidates } from './idle-sleep.js';
import { loadConfig } from './config.js';
import { readStatus } from './session-status.js';
import { swallow } from './best-effort.js';
import { resolveWebRoot } from './web-static.js';
import { serveSpa } from './spa-handler.js';
import { launch, type DiffServerHandle, type SseEvent } from './diff-server.js';
import type { ParsedFile } from './diff-parse.js';

export type WebServerHandle = DiffServerHandle;

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
  const resolved = s.paths.map((p) =>
    resolveRepoDiff(p, base, s.baseBranches?.[p] ?? s.baseBranch),
  );
  const repos = s.paths.map((p, i) => ({
    name: path.basename(p),
    root: p,
    resolvedBase: resolved[i].resolvedBase,
    files: computeDiff({ root: p, diffArg: resolved[i].diffArg }),
  }));
  return { repos, resolvedBase: resolved[0]?.resolvedBase ?? 'HEAD' };
}

export interface WebServerOptions {
  /** `POST /api/shutdown` calls this (the command's own shutdown). */
  onShutdownRequest?: () => void;
  /** When true, skip features that are only useful for the full
   *  dashboard view (Claude transcript activity watcher, etc.). Used
   *  when `wd` auto-starts work web on demand: the user opened a diff,
   *  not the dashboard, so paying for activity tracking + Claude hooks
   *  is wasted setup. Defaults to false (full dashboard).
   *
   *  Lean mode keeps:
   *    - the SPA + diff/scope routes (the reason wd needs the server)
   *    - the state.db change poll (sessions + tasks, cheap)
   *    - the broadcast / SSE infra
   *  Lean mode skips:
   *    - chokidar watcher over `~/.claude/projects` (activity feed)
   *    - the 10s decay tick (sessions-changed re-broadcast)
   *  Claude-hooks installation is gated separately in `work web`'s
   *  command handler — it's not in `startWebServer`. */
  lean?: boolean;
}

export async function startWebServer(
  opts: WebServerOptions = {},
): Promise<WebServerHandle> {
  const { lean = false } = opts;
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    throw new Error(
      'Could not find dist/web/. Run `npm run build:web` (or `npm run build`) first.',
    );
  }

  const sseListeners = new Set<(e: SseEvent) => void>();
  // /api/sessions is rebuilt from disk for EVERY session in history (365
  // on a real machine: ~60–150 ms of fs work), and every hook, diff-stat
  // change and decay tick triggers a refetch from each open tab. Cache the
  // built list; any broadcast means something changed, so it drops the
  // cache, and a short TTL covers time-based changes (activity decay).
  let sessionsCache: { at: number; body: unknown } | null = null;
  const SESSIONS_TTL_MS = 5_000;
  // `sessions-changed` makes every window refetch the whole list, and it
  // fires on every transcript write anywhere: at most one per
  // SESSIONS_EVENT_MS reaches the windows (the first at once, the last of
  // a burst at the end), so ten working Claudes don't mean a rebuild every
  // 250 ms per window. The cache is dropped right away either way.
  const SESSIONS_EVENT_MS = 750;
  const emit = (event: string, data: unknown) => {
    for (const cb of sseListeners) cb({ event, data });
  };
  const sessionsChanged = throttleTrailing(() => emit('sessions-changed', { ts: Date.now() }), SESSIONS_EVENT_MS);
  const broadcast = (event: string, data: unknown) => {
    sessionsCache = null;
    if (event === 'sessions-changed') sessionsChanged();
    else emit(event, data);
  };

  // What work does in the background, and what it decided (activity.ts):
  // the Activity panel. Its changes don't touch sessions, so they skip the
  // sessions cache, and come at most every 400 ms (a sweep notes a lot).
  let activityTimer: NodeJS.Timeout | null = null;
  const activity = createActivityLog({
    onChange: () => {
      activityTimer ??= setTimeout(() => {
        activityTimer = null;
        for (const cb of sseListeners) cb({ event: 'activity-changed', data: { ts: Date.now() } });
      }, 400);
    },
  });

  // Worktrees created or removed by other terminals, and `work todo` edits,
  // show up live: every write bumps a change counter in state.db (db.ts
  // triggers), and polling two counters once a second is cheaper than the
  // file watches it replaces.
  let seenRev = { sessions: revision('sessions'), tasks: revision('tasks') };
  const revPoll = setInterval(() => {
    const now = bestEffort('poll state.db revisions', () => ({ sessions: revision('sessions'), tasks: revision('tasks') }), seenRev) ?? seenRev;
    if (now.sessions !== seenRev.sessions) broadcast('sessions-changed', { ts: Date.now() });
    if (now.tasks !== seenRev.tasks) broadcast('tasks-changed', { ts: Date.now() });
    seenRev = now;
  }, 1000);
  revPoll.unref?.();

  // Watch Claude's per-project transcripts so the dashboard sees external
  // terminals coming alive. Claude writes constantly while it's thinking;
  // the watcher debounces to 250 ms so we don't spam the sidebar 100×/s
  // mid-turn. The same broadcast also covers our own PTYs writing here.
  const projectsRoot = claudeProjectsRoot();
  let activityWatcher: { stop(): void } | null = null;
  if (!lean) {
    try {
      if (fs.existsSync(projectsRoot)) {
        // …and the per-process files, so a Claude opened or closed in a
        // terminal tab shows at once (live-claudes.ts).
        const sessionsDir = claudeSessionsDir();
        activityWatcher = createFsWatcher({
          roots: fs.existsSync(sessionsDir) ? [projectsRoot, sessionsDir] : [projectsRoot],
          debounceMs: 250,
          onChange: () => broadcast('sessions-changed', { ts: Date.now() }),
        });
      }
    } catch { /* watcher startup is best-effort */ }
  }

  // Decay tick: even when nothing writes, sessions transition active → open
  // → stale purely by elapsed time. Re-broadcast every 10 s so the badges
  // catch up. Cheap — the client just refetches /api/sessions. Skipped
  // in lean mode (no dashboard consumer).
  const decayTick = lean
    ? null
    : setInterval(
        () => broadcast('sessions-changed', { ts: Date.now() }),
        10_000,
      );

  // Old `wd --static` pages and dead daemon logs pile up in ~/.work/diffs
  // (16 MB on one machine). Sweep them off the startup path.
  const sweepTimer = setTimeout(() => {
    bestEffort('sweep old diff artifacts', () => sweepOldDiffArtifacts(), null);
  }, 5_000);
  sweepTimer.unref?.();

  const app = new Hono();

  // pid lets `work web --stop` confirm it's killing THIS server, not a
  // process that reused a stale web.pid (core/web-discovery.ts).
  app.get('/api/context', (c) => c.json({ mode: 'dashboard', pid: process.pid, lean, build: buildStamp() }));
  app.get('/api/activity', (c) => c.json(activity.snapshot() satisfies ActivityWire));

  // Graceful stop, for `work web --stop`: on Windows killing the process is
  // TerminateProcess, which skips the shutdown path (Claude hooks stay in
  // ~/.claude/settings.json, checkpoint refs aren't swept). Mutating, so the
  // origin guard keeps web pages out; the CLI sends no Origin.
  app.post('/api/shutdown', (c) => {
    if (!opts.onShutdownRequest) return c.json({ error: 'shutdown not available' }, 501);
    setTimeout(() => opts.onShutdownRequest?.(), 50); // answer first
    return c.json({ ok: true, pid: process.pid });
  });

  // `+N −M` per row, computed in the background (never inline) and
  // broadcast once when values change — see diff-stat.ts.
  let diffStatBroadcast: NodeJS.Timeout | null = null;
  const diffStats = new DiffStatCache({
    onChange: () => {
      if (diffStatBroadcast) return;
      diffStatBroadcast = setTimeout(() => {
        diffStatBroadcast = null;
        broadcast('sessions-changed', { ts: Date.now() });
      }, 500);
    },
  });
  const repoNames = (s: WorktreeSession) => (s.isGroup ? s.paths.map((p) => path.basename(p)) : [s.target]);
  const diffStatFor = (id: string, s: WorktreeSession, hasStatus: boolean) =>
    wantsDiffStat(s, hasStatus) ? diffStats.get(id, s.paths, repoNames(s)) : null;

  app.get('/api/sessions', (c) => {
    if (!sessionsCache || Date.now() - sessionsCache.at > SESSIONS_TTL_MS) {
      const history = loadHistory();
      // Old entries sharing a folder with the branch checked out there get
      // none of that folder's activity; every running Claude (your terminal
      // tabs included) goes to the entry that owns its folder.
      const shadow = shadowedSessions(history, branchCheckedOut);
      // A process table refreshed in the background: listing every process
      // synchronously (tasklist) on each build blocked the server.
      const table = recentProcessTable(5_000) ?? undefined;
      const running = claudesBySession(readLiveClaudes(undefined, undefined, table), history.filter((s) => !shadow.has(sessionIdFor(s))));
      const appPids = new Set([...ptyPids(), ...chatApi.pids()]);
      const claudesFor = (id: string) => summarizeClaudes(running.get(id) ?? [], appPids);
      const drafts = draftCounts();
      const sessions = history.map((s) =>
        sessionWire(s, {
          diffStatFor,
          claudesFor,
          shadowed: (id) => shadow.has(id),
          reviewThreadsFor: (id) => reviewThreadsOf(prWatch.state(id)),
          replyDraftsFor: (id) => drafts.get(id) ?? 0,
        }),
      );
      // Sessions changing the same files — from the same background cache
      // as the stats, so this costs no git of its own.
      const overlaps = findOverlaps(
        sessions
          .filter((w) => w.diffStat !== null && !w.archivedAt)
          .map((w) => ({ id: w.id, target: w.target, branch: w.branch, touched: diffStats.touched(w.id) })),
      );
      for (const w of sessions) {
        const o = overlaps.get(w.id);
        if (o) w.overlaps = o;
      }
      sessionsCache = { at: Date.now(), body: { sessions } };
    }
    return c.json(sessionsCache.body);
  });

  // A session's checkpoint history lives in its diff SCOPE (the machinery
  // `wd` uses: one step per Claude instruction, taken by the Stop hook). The
  // dashboard addresses sessions, so these routes make sure the session's
  // scope exists — the manifest on disk survives restarts, the in-memory
  // registration doesn't — and hide scopes from the SPA.
  let scopeApi: ReturnType<typeof mountScopeRoutes> | null = null;
  const sessionScope = (session: WorktreeSession) =>
    bestEffort(
      `checkpoint scope for ${session.target}:${session.branch}`,
      () => scopeApi?.sessionScope(session.paths, `${session.target} · ${session.branch}`) ?? null,
      null,
    ) ?? null;

  // GETs change nothing (§1.5 — a page on another site can make the browser
  // open one). The turns are read from the manifest on disk by hash, so
  // they're there right after a work web restart too; the scope that
  // records them is created by the status hook (a POST), not here.
  app.get('/api/sessions/:id/checkpoints', (c) => {
    const session = findSession(c.req.param('id'));
    if (!session) return c.json({ error: 'unknown session' }, 404);
    const hash = scopeHashForPaths(session.paths);
    return c.json({ scopeHash: hash, entries: loadManifest(hash).entries });
  });

  app.get('/api/sessions/:id/diff', async (c) => {
    const id = c.req.param('id');
    const session = findSession(id);
    if (!session) return c.json({ error: 'unknown session' }, 404);
    // Range between two checkpoints (e.g. "last turn"): delegate to the
    // scope's range diff, which already handles groups and 'working'.
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from !== undefined && to !== undefined) {
      // Only the in-memory record the range diff route checks paths against
      // — no baseline snapshot, no watcher (those come with the hook).
      const scope = findScope(session.paths) ?? bestEffort('register scope', () => registerScope(session.paths, `${session.target} · ${session.branch}`), null);
      if (!scope) return c.json({ error: 'no checkpoints for this session' }, 404);
      const res = await app.request(
        `/api/scopes/${encodeURIComponent(scope.hash)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const body = (await res.json()) as Record<string, unknown>;
      return c.json(res.ok ? { ...body, sessionId: id, base: 'range' } : body, res.ok ? 200 : (res.status as 400));
    }
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

  // Revert an uncommitted file/hunk and tell Claude (posts via the comment
  // route above, so it's delivered like any review note).
  mountRevertRoutes(app, { uncommitted: (s) => computeSessionDiff(s, 'uncommitted').repos });

  // Per-worktree dev server + preview on its $PORT.
  mountDevRoutes(app, { broadcast });

  // PR watch: CI state for the header strip; auto-archive once merged and
  // tell a session's Claude when its CI fails. Polls gh, so full mode only.
  // A session's unresolved review threads colour it in every list, so a
  // change in that count is a sessions change too.
  const threadsShown = new Map<string, number>();
  const prWatch = mountCiRoutes(app, {
    broadcast: (event, data) => {
      broadcast(event, data);
      const id = event === 'ci-changed' ? (data as { sessionId?: string }).sessionId : undefined;
      if (!id) return;
      const n = reviewThreadsOf(prWatch.state(id));
      if (n === (threadsShown.get(id) ?? 0)) return;
      threadsShown.set(id, n);
      broadcast('sessions-changed', { ts: Date.now() });
    },
    activity,
    archive: async (id) => {
      const s = findSession(id);
      if (!s || s.archivedAt) return;
      await archiveSession(s, defaultArchiveDeps({ release: releaseSession }));
      broadcast('sessions-changed', { ts: Date.now() });
    },
  });
  const stopPrWatch = lean ? null : prWatch.start(180_000);

  // Idle Claudes nobody is looking at go to sleep (idle-sleep.ts): they stop
  // holding memory, and opening the session resumes the conversation.
  const SLEEP_EVERY_MS = 5 * 60_000;
  const sleepSchedule = lean ? null : activity.schedule('idle-sleep', 'Idle Claude check', SLEEP_EVERY_MS);
  const sleepIdle = async () => {
    sleepSchedule?.next(Date.now() + SLEEP_EVERY_MS);
    const minutes = loadConfig()?.sleepIdleAfterMinutes ?? DEFAULT_SLEEP_AFTER_MINUTES;
    if (sleepAfterMs(minutes) === 0) return activity.skip('idle-sleep', 'Looking for idle Claudes', 'turned off (sleepIdleAfterMinutes: 0)');
    const run = activity.start('idle-sleep', 'Looking for idle Claudes');
    const ptys = await listHostPtys().catch(() => []);
    const busy = (id: string) => {
      const st = readStatus(id)?.state;
      return st === 'working' || st === 'needs_input';
    };
    const ids = sleepCandidates(ptys, Date.now(), sleepAfterMs(minutes), busy);
    for (const id of ids) {
      report('detail', `[sleep] ${id}: idle ${minutes} min with nothing attached; stopping its Claude (opening the session resumes it)`);
      const s = findSession(id);
      await disposePty(id).then(
        () => run.note(`${s ? `${s.target} ${s.branch}` : id}: put its Claude to sleep (printed nothing for ${Math.max(minutes, 30)} min, nothing attached; opening it resumes the conversation)`, { level: 'action', sessionId: id }),
        (err: Error) => run.note(`${id}: couldn't stop its Claude: ${err.message}`, { level: 'warn', sessionId: id }),
      );
    }
    // Headless chats too: idle that long with no chat view open.
    const chats = chatApi.idle(sleepAfterMs(minutes));
    for (const id of chats) {
      chatApi.stop(id);
      const s = findSession(id);
      run.note(`${s ? `${s.target} ${s.branch}` : id}: put its chat's Claude to sleep (idle ${Math.max(minutes, 30)} min, no chat open; your next message resumes it)`, { level: 'action', sessionId: id });
    }
    const slept = ids.length + chats.length;
    run.done(`${ptys.length} Claude${ptys.length === 1 ? '' : 's'} running · ${slept ? `${slept} put to sleep` : 'none idle long enough'}`);
    if (ids.length) broadcast('sessions-changed', { ts: Date.now() });
  };
  sleepSchedule?.next(Date.now() + SLEEP_EVERY_MS);
  const sleepTimer = lean ? null : setInterval(() => void sleepIdle(), SLEEP_EVERY_MS);

  // Old archived conversations get compressed (archive-retention.ts): a few
  // minutes after start, then daily.
  const RETENTION_EVERY_MS = 24 * 3600_000;
  const retentionSchedule = lean ? null : activity.schedule('archive', 'Archive upkeep', RETENTION_EVERY_MS);
  const archiveUpkeep = () => {
    retentionSchedule?.next(Date.now() + RETENTION_EVERY_MS);
    const cfg = loadConfig()?.archive;
    const run = activity.start('archive', 'Compressing old archived conversations');
    try {
      const r = applyArchiveRetention({ compressAfterDays: cfg?.compressAfterDays, dropAfterDays: cfg?.dropTranscriptsAfterDays });
      const mb = Math.round(r.bytesSaved / 1e6);
      run.done(
        r.compressed.length || r.dropped.length
          ? `${r.compressed.length} compressed${r.dropped.length ? `, ${r.dropped.length} conversations deleted (config)` : ''} · ${mb} MB freed`
          : 'nothing old enough',
      );
    } catch (err) {
      run.fail((err as Error).message);
    }
  };
  const retentionFirst = lean ? null : setTimeout(archiveUpkeep, 3 * 60_000);
  retentionFirst?.unref?.();
  retentionSchedule?.next(Date.now() + 3 * 60_000);
  const retentionTimer = lean ? null : setInterval(archiveUpkeep, RETENTION_EVERY_MS);
  retentionTimer?.unref?.();
  sleepTimer?.unref?.();

  // "What did each session do today?" — read from what's on disk (see
  // digest.ts); PR state from the watch's cache, no gh call here.
  const digest = createDigestSource({ diffStatFor: (id) => diffStats.peek(id), ciFor: (id) => prWatch.state(id) });
  app.get('/api/digest', async (c) => {
    const body: DigestResponse = await digest.collect(Date.parse(c.req.query('since') ?? ''));
    return c.json(body);
  });

  // Replies to PR review threads: Claude drafts, you post (pr-replies.ts).
  mountPrReplyRoutes(app, { broadcast, activity });

  // Clean up view: which worktrees can go (scan), and removing them.
  mountCleanupRoutes(app, { broadcast, activity });

  // The Ctrl+K assistant: what the dashboard shows, for its prompt hook.
  // Stats and overlaps from the same caches the session list uses.
  mountAssistantRoutes(app, {
    wireOptions: { diffStatFor: (id) => diffStats.peek(id) },
    overlapsFor: (id) =>
      ((sessionsCache?.body as { sessions?: SessionWire[] } | undefined)?.sessions ?? []).find((w) => w.id === id)?.overlaps,
  });

  // PRs / Jira / Tasks read endpoints + tasks CRUD. Emits tasks-changed.
  mountPanesRoutes(app, { broadcast, activity });

  // Worktree mutations (create/remove/sync/rebase/open-editor). Each
  // emits sessions-changed so the sidebar refreshes.
  mountWorktreeRoutes(app, { broadcast });

  // Ad-hoc scopes registered by `wd` invocations — gives the dashboard
  // an addressable URL per scope (/diff/<hash>, /review/<hash>) so we
  // can collapse the standalone wd-server/wd -c daemons into this
  // single process.
  scopeApi = mountScopeRoutes(app, { broadcast });

  // PTY upgrade endpoint. Returns a noop response — the upgrade is handled
  // by the server's `upgrade` event below.
  mountTerminalRoutes(app);

  // Attention inbox: hook nudges + mark-seen. A status change usually means
  // a turn touched files, so the row's +N −M refreshes too.
  mountStatusRoutes(app, {
    broadcast,
    onStatusChanged: (id) => {
      diffStats.invalidate(id);
      // Make sure this session's turns are checkpointed ("last turn" diffs)
      // from its first hook on, not only once someone opens it.
      const session = findSession(id);
      if (session) sessionScope(session);
    },
  });

  // Ship (push / PR / merge) + archive.
  // Before an archive removes a worktree: close our watcher and any chat on it.
  const releaseSession = async (id: string) => {
    await disposeSessionWatcher(id);
    chatApi.stop(id);
  };
  mountShipRoutes(app, { broadcast, onRepoChanged: (id) => diffStats.invalidate(id), release: releaseSession });

  // The sessions list's manual order (drag to reorder).
  mountSessionOrderRoutes(app, { broadcast });

  // A session's Claude as a chat: headless, instead of the terminal (spike).
  let selfUrl = '';
  const chatApi = mountChatRoutes(app, { baseUrl: () => selfUrl });

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
  selfUrl = handle.url;
  const wsBridge = attachTerminalWs(handle.httpServer, handle.port);
  // Pick up PTYs that survived a previous `work web` in the PTY host so
  // their badges show immediately. Never spawns a host.
  void initPtyPool();
  report('detail', `[web] dashboard at ${handle.url}`);

  return {
    url: handle.url,
    port: handle.port,
    stop: async () => {
      clearInterval(revPoll);
      if (decayTick) clearInterval(decayTick);
      stopPrWatch?.();
      if (sleepTimer) clearInterval(sleepTimer);
      chatApi.stopAll();
      clearTimeout(sweepTimer);
      activityWatcher?.stop();
      disposeAllWatchers();
      // Sweep checkpoint refs + manifests for every active scope BEFORE
      // wiping the registry — otherwise `refs/wd/<hash>/*` refs leak
      // across `work web` restarts and accumulate without bound in
      // every repo the user has reviewed.
      // Not the sessions' own scopes: their turn history outlives restarts.
      for (const scope of scopesToSweep(listScopes(), loadHistory().map((s) => s.paths))) {
        try {
          clearCheckpoints(scope.hash, scope.paths);
        } catch {
          // Best-effort — partial cleanup is fine, log only matters for
          // diagnosis and doesn't change the shutdown outcome.
        }
      }
      disposeAllScopes();
      // PTYs live in the PTY host and outlive the dashboard — detach only.
      detachPtyPool();
      wsBridge.close();
      await handle.stop();
    },
  };
}
