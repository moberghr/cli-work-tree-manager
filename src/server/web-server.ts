import fs from 'node:fs';
import { mountSessionControlRoutes } from './routes/session-control-routes.js';
import os from 'node:os';
import { defaultRunner } from '../core/pr/ship.js';
import type { NotifyEvent } from '../core/api-types.js';
import { sessionStacks } from '../core/stacks/stack-sessions.js';
import { retargetChildrenOf, syncStacksAfterTurn } from '../core/stacks/stack-sync.js';
import { logSwallowed } from '../core/platform/best-effort.js';
import { shownState } from '../core/status/turn-activity.js';
import { BehindCache } from '../core/stacks/behind-main.js';
import { mountUpdateRoutes } from './routes/update-routes.js';
import { mountCatchUpRoutes } from './routes/catch-up-routes.js';
import { askCatchUp, catchUpFacts } from '../core/conversations/catch-up-deps.js';
import { catchUp } from '../core/conversations/catch-up.js';
import { mountForkRoutes } from './routes/fork-routes.js';
import { defaultForkDeps } from '../core/sessions/fork-deps.js';
import { createInChild, oneAtATime, type CreateWorktree } from '../core/worktree/setup-child.js';
import { allSnoozes } from '../core/rail/snooze-store.js';
import { sessionsWithNotes } from '../core/rail/session-notes.js';
import { mountNoteRoutes } from './routes/note-routes.js';
import { mountTimelineRoutes } from './routes/timeline-routes.js';
import { allBlocks, blockerDone, blockKey, sweepBlocks, unblockedPrompt } from '../core/rail/session-blocks.js';
import { mountBlockRoutes } from './routes/block-routes.js';
import { mountJiraWatchRoutes } from './routes/jira-watch-routes.js';
import { describeStall, watchLoop } from './loop-watch.js';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { computeDiff } from '../core/diff/diff-pipeline.js';
import { resolveRepoDiff } from '../core/diff/diff-scope.js';
import { loadHistory, type WorktreeSession } from '../core/sessions/history.js';
import { disposeAllWatchers, disposeSessionWatcher, findSession, subscribeSession } from '../core/sessions/web-state.js';
import { createFsWatcher } from '../core/platform/fs-watcher.js';
import { mountSessionCommentRoutes } from './routes/session-comment-routes.js';
import { mountPanesRoutes } from './routes/panes-routes.js';
import { mountWorktreeRoutes } from './routes/worktree-routes.js';
import { mountScopeRoutes } from './routes/scope-routes.js';
import { mountTerminalRoutes } from './routes/terminal-routes.js';
import { mountStatusRoutes } from './routes/status-routes.js';
import { mountShipRoutes } from './routes/ship-routes.js';
import { mountChatRoutes } from './routes/chat-routes.js';
import { mountSessionOrderRoutes } from './routes/session-order-routes.js';
import { mountRailRoutes } from './routes/rail-routes.js';
import { onArchived } from '../core/archive/session-archive.js';
import { defaultArchiveDeps, archiveMergedSession } from '../core/archive/session-archive-deps.js';
import { agentsBySession, summarizeAgents } from '../core/sessions/live-agents.js';
import { liveAgents, activityRoots } from '../core/agents/index.js';
import { branchCheckedOut, shadowedSessions } from '../core/worktree/shared-folders.js';
import { sessionIdFor } from '../core/sessions/session-id.js';
import { DiffStatCache, wantsDiffStat } from '../core/diff/diff-stat.js';
import { findOverlaps } from '../core/diff/overlap.js';
import { buildStamp } from '../core/platform/build-stamp.js';
import { reviewThreadsOf, sessionWire } from '../core/sessions/session-wire.js';
import { createDigestSource } from '../core/conversations/digest-source.js';
import { report } from '../core/platform/report.js';
import { mountCleanupRoutes } from './routes/cleanup-routes.js';
import { mountAssistantRoutes } from './routes/assistant-routes.js';
import type { ActivityWire, DigestResponse, SessionWire } from '../core/api-types.js';
import { createActivityLog } from '../core/platform/activity.js';
import { recentProcessTable } from '../core/platform/process.js';
import { throttleTrailing } from '../core/platform/throttle.js';
import { mountPrReplyRoutes, openThreadsOfCi } from './routes/pr-reply-routes.js';
import { applyArchiveRetention } from '../core/archive/archive-retention.js';
import { syncConversation, syncConversations } from '../core/conversations/conversation-store.js';
import { draftCounts } from '../core/pr/pr-replies.js';
import { bestEffort } from '../core/platform/best-effort.js';
import { loadManifest } from '../core/diff/checkpoint.js';
import { mountRevertRoutes } from './routes/revert-routes.js';
import { mountDevRoutes } from './routes/dev-routes.js';
import { mountCiRoutes } from './routes/ci-routes.js';
import { sweepOldDiffArtifacts } from '../core/diff/diffs-sweep.js';
import { revision } from '../core/platform/db.js';
import { disposeAllScopes, findScope, listScopes, registerScope, scopeHashForPaths, scopesToSweep } from '../core/diff/scope-manager.js';
import { clearCheckpoints } from '../core/diff/checkpoint.js';
import { attachTerminalWs } from './terminal-ws.js';
import {
  detachPtyPool,
  disposePty,
  getWorkBin,
  hostBeat,
  initPtyPool,
  listHostPtys,
  outputStatus,
  peekPty,
  ptyPids,
} from '../core/pty/pty-pool.js';
import { hostHealth, type HostHealth } from '../core/pty/host-health.js';
import { DEFAULT_SLEEP_AFTER_MINUTES, sleepAfterMs, sleepCandidates } from '../core/pty/idle-sleep.js';
import { loadConfig } from '../core/platform/config.js';
import { readStatus } from '../core/status/session-status.js';
import { resolveWebRoot } from '../core/platform/web-static.js';
import { serveSpa } from './spa-handler.js';
import { launch, type DiffServerHandle, type SseEvent } from './diff-server.js';
import type { ParsedFile } from '../core/diff/diff-parse.js';

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
  const resolved = s.paths.map((p) => resolveRepoDiff(p, base, s.baseBranches?.[p] ?? s.baseBranch));
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

export async function startWebServer(opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const { lean = false } = opts;
  const webRoot = resolveWebRoot();
  if (!webRoot) {
    throw new Error('Could not find dist/web/. Run `npm run build:web` (or `npm run build`) first.');
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
  const revs = () => ({ sessions: revision('sessions'), tasks: revision('tasks'), rail: revision('rail') });
  let seenRev = revs();
  const revPoll = setInterval(() => {
    const now = bestEffort('poll state.db revisions', revs, seenRev) ?? seenRev;
    if (now.sessions !== seenRev.sessions) broadcast('sessions-changed', { ts: Date.now() });
    if (now.tasks !== seenRev.tasks) broadcast('tasks-changed', { ts: Date.now() });
    // Pins and sections changed by another process (`work pin`, `work section`).
    if (now.rail !== seenRev.rail) broadcast('rail-changed', { ts: Date.now() });
    seenRev = now;
  }, 1000);
  revPoll.unref?.();

  // Watch every agent's activity folders (its conversations, its process
  // state: agents/ `activityRoots`) so the dashboard sees external terminals
  // coming alive. An agent writes constantly while it's thinking; the watcher
  // debounces to 250 ms so we don't spam the sidebar 100×/s mid-turn. The
  // same broadcast also covers our own PTYs writing there.
  let activityWatcher: { stop(): void } | null = null;
  if (!lean) {
    try {
      const roots = activityRoots().filter((r) => fs.existsSync(r));
      if (roots.length > 0) {
        activityWatcher = createFsWatcher({
          roots,
          debounceMs: 250,
          onChange: () => broadcast('sessions-changed', { ts: Date.now() }),
        });
      }
    } catch {
      /* watcher startup is best-effort */
    }
  }

  // Decay tick: even when nothing writes, sessions transition active → open
  // → stale purely by elapsed time. Re-broadcast every 10 s so the badges
  // catch up. Cheap — the client just refetches /api/sessions. Skipped
  // in lean mode (no dashboard consumer).
  const decayTick = lean ? null : setInterval(() => broadcast('sessions-changed', { ts: Date.now() }), 10_000);

  // Old `wd --static` pages and dead daemon logs pile up in ~/.work/diffs
  // (16 MB on one machine). Sweep them off the startup path.
  const sweepTimer = setTimeout(() => {
    bestEffort('sweep old diff artifacts', () => sweepOldDiffArtifacts(), null);
  }, 5_000);
  sweepTimer.unref?.();

  const app = new Hono();

  // A blocked event loop holds back everything — the status a hook just
  // recorded included. Say when it happens, and what ran (loop-watch.ts).
  const loop = watchLoop({
    onStall: (st) => {
      report('warn', `[server] ${describeStall(st)}`);
      if (!lean) activity.start('server', 'Server responsiveness').done(describeStall(st));
    },
  });
  app.use(async (c, next) => {
    const t0 = performance.now();
    await next();
    if (!(c.res.headers.get('content-type') ?? '').includes('text/event-stream'))
      loop.request(`${c.req.method} ${c.req.path}`, performance.now() - t0);
  });

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
  // Behind main, per session: slow refresh (main moves slowly), a broadcast when it changes.
  // Making a worktree runs git synchronously: in a child `work tree --setup-only`,
  // so a slow fetch doesn't hold up every request (setup-child.ts).
  const makeWorktree: CreateWorktree = oneAtATime((req, config) => createInChild(getWorkBin())(req, config));
  const behindCache = new BehindCache({ onChange: () => broadcast('sessions-changed', { ts: Date.now() }) });
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
      const running = agentsBySession(
        liveAgents(table),
        history.filter((s) => !shadow.has(sessionIdFor(s))),
      );
      const appPids = new Set([...ptyPids(), ...chatApi.pids()]);
      const claudesFor = (id: string) => summarizeAgents(running.get(id) ?? [], appPids);
      const drafts = draftCounts();
      const snoozes = allSnoozes();
      const noted = sessionsWithNotes();
      const blocks = allBlocks();
      const live = new Set(history.filter((x) => !x.archivedAt).map((x) => sessionIdFor(x)));
      // Stacked sessions (stack.ts): behind and Update measure against the parent.
      const stacks = sessionStacks(history, loadConfig());
      const sessions = history.map((s) =>
        sessionWire(s, {
          diffStatFor,
          claudesFor,
          liveKnown: !!table && table.size > 0,
          snoozeFor: (id) => snoozes.get(id) ?? null,
          behindFor: (id, s) => (wantsDiffStat(s, false) ? behindCache.get(id, s.paths, stacks.parentOf.get(id)?.branch) : null),
          stackFor: (id) => {
            const p = stacks.parentOf.get(id);
            const m = stacks.mergedParentOf.get(id);
            return {
              parent: p ? { id: p.id, branch: p.branch, ...(p.title ? { title: p.title } : {}) } : null,
              children: stacks.children.get(id) ?? 0,
              merged: m ? { id: m.id, branch: m.branch } : null,
            };
          },
          hostedLive: (id) => peekPty(id) || chatApi.running(id),
          outputStatusFor: (id) => outputStatus(id),
          shadowed: (id) => shadow.has(id),
          reviewThreadsFor: (id) => reviewThreadsOf(prWatch.state(id)),
          replyDraftsFor: (id) => drafts.get(id) ?? 0,
          hasNote: (id) => noted.has(id),
          blockedByFor: (id) =>
            (blocks.get(id)?.by ?? [])
              .filter((b) => !blockerDone(b, (x) => !live.has(x)))
              .map((b) => ({
                key: blockKey(b),
                kind: b.kind,
                label: b.label,
                ...(b.kind === 'session' ? { sessionId: b.id } : { url: b.url, ...(b.state ? { state: b.state } : {}) }),
              })),
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
      const scope =
        findScope(session.paths) ??
        bestEffort('register scope', () => registerScope(session.paths, `${session.target} · ${session.branch}`), null);
      if (!scope) return c.json({ error: 'no checkpoints for this session' }, 404);
      const res = await app.request(
        `/api/scopes/${encodeURIComponent(scope.hash)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      const body = (await res.json()) as Record<string, unknown>;
      return c.json(res.ok ? { ...body, sessionId: id, base: 'range' } : body, res.ok ? 200 : (res.status as 400));
    }
    const baseParam = c.req.query('base') ?? 'uncommitted';
    const base: DiffBase = baseParam === 'branch' ? 'branch' : 'uncommitted';
    try {
      const { repos, resolvedBase } = computeSessionDiff(session, base);
      return c.json({ sessionId: id, base, resolvedBase, repos });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Per-session comments (file-backed). Emits comments-changed via broadcast.
  mountSessionCommentRoutes(app, { broadcast });

  // Driving a session from outside its terminal: send, start, stop, its screen (`work send` …).
  mountSessionControlRoutes(app, { broadcast });

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
    // The PR merged: nothing waiting in it holds it up — the archive keeps it.
    archive: (id) =>
      archiveMergedSession(id, defaultArchiveDeps({ release: releaseSession }), () => broadcast('sessions-changed', { ts: Date.now() })),
  });
  const stopPrWatch = lean ? null : prWatch.start(180_000);

  // Idle Claudes nobody is looking at go to sleep (idle-sleep.ts): they stop
  // holding memory, and opening the session resumes the conversation.
  const SLEEP_EVERY_MS = 5 * 60_000;
  const sleepSchedule = lean ? null : activity.schedule('idle-sleep', 'Idle Claude check', SLEEP_EVERY_MS);
  const sleepIdle = async () => {
    sleepSchedule?.next(Date.now() + SLEEP_EVERY_MS);
    const minutes = loadConfig()?.sleepIdleAfterMinutes ?? DEFAULT_SLEEP_AFTER_MINUTES;
    if (sleepAfterMs(minutes) === 0)
      return activity.skip('idle-sleep', 'Looking for idle Claudes', 'turned off (sleepIdleAfterMinutes: 0)');
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
        () =>
          run.note(
            `${s ? `${s.target} ${s.branch}` : id}: put its Claude to sleep (printed nothing for ${Math.max(minutes, 30)} min, nothing attached; opening it resumes the conversation)`,
            { level: 'action', sessionId: id },
          ),
        (err: Error) => run.note(`${id}: couldn't stop its Claude: ${err.message}`, { level: 'warn', sessionId: id }),
      );
    }
    // Headless chats too: idle that long with no chat view open.
    const chats = chatApi.idle(sleepAfterMs(minutes));
    for (const id of chats) {
      chatApi.stop(id);
      const s = findSession(id);
      run.note(
        `${s ? `${s.target} ${s.branch}` : id}: put its chat's Claude to sleep (idle ${Math.max(minutes, 30)} min, no chat open; your next message resumes it)`,
        { level: 'action', sessionId: id },
      );
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

  // work's own copy of every conversation (conversation-store.ts), so they
  // stay searchable after Claude Code deletes its transcripts: each session
  // after its turns (below, onStatusChanged), and all of them a minute after
  // start and every 30 minutes.
  const CONVERSATIONS_EVERY_MS = 30 * 60_000;
  const conversationsSchedule = lean ? null : activity.schedule('conversations', 'Keep conversations', CONVERSATIONS_EVERY_MS);
  let conversationsBusy = false;
  const keepConversations = async () => {
    conversationsSchedule?.next(Date.now() + CONVERSATIONS_EVERY_MS);
    if (conversationsBusy) return;
    conversationsBusy = true;
    const run = activity.start('conversations', 'Copying new conversation lines');
    try {
      // An archived session's Claude is stopped: its archive has the rest.
      const r = await syncConversations(loadHistory().filter((s) => !s.archivedAt));
      run.done(
        r.files
          ? `${r.sessions} session${r.sessions === 1 ? '' : 's'} · ${r.files} transcript${r.files === 1 ? '' : 's'} · ${Math.round(r.bytes / 1e3)} KB copied`
          : 'all up to date',
      );
    } catch (err) {
      run.fail((err as Error).message);
    } finally {
      conversationsBusy = false;
    }
  };
  const conversationsFirst = lean ? null : setTimeout(() => void keepConversations(), 60_000);
  conversationsFirst?.unref?.();
  conversationsSchedule?.next(Date.now() + 60_000);
  const conversationsTimer = lean ? null : setInterval(() => void keepConversations(), CONVERSATIONS_EVERY_MS);
  conversationsTimer?.unref?.();
  // After a turn: that session only, a few seconds later (a turn's hooks
  // come in bursts), one copy per session at a time.
  const conversationSyncs = new Map<string, ReturnType<typeof setTimeout>>();
  const syncConversationSoon = (s: WorktreeSession) => {
    const id = sessionIdFor(s);
    if (lean || conversationSyncs.has(id)) return;
    const t = setTimeout(() => {
      void syncConversation(s)
        .catch((err: Error) => report('detail', `[conversations] ${s.target}:${s.branch}: ${err.message}`))
        .finally(() => conversationSyncs.delete(id));
    }, 5_000);
    t.unref?.();
    conversationSyncs.set(id, t);
  };

  // "What did each session do today?" — read from what's on disk (see
  // digest.ts); PR state from the watch's cache, no gh call here.
  const digest = createDigestSource({ diffStatFor: (id) => diffStats.peek(id), ciFor: (id) => prWatch.state(id) });
  app.get('/api/digest', async (c) => {
    const body: DigestResponse = await digest.collect(Date.parse(c.req.query('since') ?? ''));
    return c.json(body);
  });

  // Replies to PR review threads: Claude drafts, posted on your yes (pr-replies.ts).
  mountPrReplyRoutes(app, {
    broadcast,
    activity,
    openThreads: (id) => openThreadsOfCi(prWatch.state(id)),
  });

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

  // The Jira watch: newly assigned issues started in the right project
  // (jira-watch.ts), on/off in the Jira tab. Sweeps in full mode only.
  const jiraWatch = mountJiraWatchRoutes(app, { broadcast, activity, lean, create: makeWorktree });

  // Stacked sessions (stack-sync.ts): after a turn ends, bring a parent's new
  // commits into the idle, clean sessions stacked on it — and into this one,
  // when it is itself stacked and its parent moved while it worked.
  const stackSyncing = new Set<string>();
  const stackDeps = {
    history: loadHistory,
    config: loadConfig,
    invalidate: (sid: string) => {
      behindCache.invalidate(sid);
      diffStats.invalidate(sid);
    },
    startRun: () => activity.start('stacks', 'Updating stacked sessions'),
    busy: stackSyncing,
    shownState,
    tell: async (s: WorktreeSession, body: string) => {
      const res = await app.request(`/api/sessions/${encodeURIComponent(sessionIdFor(s))}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side: 'general', status: 'published', body }),
      });
      if (!res.ok) throw new Error(`posting the note failed: ${res.status}`);
    },
  };
  const syncStacksAfter = async (id: string) => {
    if (readStatus(id)?.state !== 'idle') return;
    const updated = await syncStacksAfterTurn(id, stackDeps);
    if (updated) broadcast('sessions-changed', { ts: Date.now() });
  };
  // A session archived (merged): the sessions stacked on it move onto main —
  // not only after their own next turn, which may never come.
  // "Blocked by" (session-blocks.ts): a session waiting on another's work, or
  // on a PR, is let go when that is done — told to you and to its Claude.
  const BLOCKS_EVERY_MS = 3 * 60_000;
  // Set once the status routes are mounted (below); they own presence.
  let statusNotify: { notify: (event: NotifyEvent, sessionName: string) => void } | null = null;
  // GitHub's limit spent (gh says so): no more PR questions until then.
  let ghRestUntil = 0;
  const blocksSchedule = lean ? null : activity.schedule('blocks', 'Waiting on other work', BLOCKS_EVERY_MS);
  let blocksBusy = false;
  const sweepBlocksNow = async () => {
    blocksSchedule?.next(Date.now() + BLOCKS_EVERY_MS);
    if (blocksBusy || allBlocks().size === 0) return;
    blocksBusy = true;
    const run = activity.start('blocks', 'Checking what sessions wait on');
    try {
      const history = loadHistory();
      const live = new Set(history.filter((x) => !x.archivedAt).map((x) => sessionIdFor(x)));
      const freed = await sweepBlocks({
        blocks: allBlocks,
        sessionGone: (id) => !live.has(id),
        prState: async (url) => {
          if (Date.now() < ghRestUntil) return null;
          const r = await defaultRunner('gh', ['pr', 'view', url, '--json', 'state', '-q', '.state'], os.tmpdir());
          if (r.code !== 0 && /rate limit/i.test(r.stderr)) {
            ghRestUntil = Date.now() + 10 * 60_000; // as the PR watch rests
            run.note('GitHub API limit reached: resting 10 minutes', { level: 'warn' });
            return null;
          }
          const st = r.code === 0 ? r.stdout.trim() : '';
          return st === 'OPEN' || st === 'MERGED' || st === 'CLOSED' ? st : null;
        },
        unblocked: async (id, done) => {
          const s = history.find((x) => sessionIdFor(x) === id);
          const name = s ? `${s.target} · ${s.branch}` : id;
          run.note(`${name}: no longer waiting (${done.map((b) => b.label).join(', ')})`, { sessionId: id });
          const event = {
            sessionId: id,
            kind: 'unblocked',
            title: `Unblocked — ${name}`,
            body: `What it waited on is done: ${done.map((b) => b.label).join(', ')}`,
          } satisfies NotifyEvent;
          // Like every notification: by presence (a tab looking at it, the browser's, or the desktop's).
          if (statusNotify) statusNotify.notify(event, name);
          else broadcast('notify', event);
          if (s) await stackDeps.tell(s, unblockedPrompt(done)).catch((err) => logSwallowed(`telling ${name} it is unblocked`, err));
        },
      });
      run.done(freed.length ? `${freed.length} unblocked` : 'still waiting');
      if (freed.length) broadcast('sessions-changed', { ts: Date.now() });
    } catch (err) {
      run.fail((err as Error).message);
    } finally {
      blocksBusy = false;
    }
  };
  const blocksTimer = lean ? null : setInterval(() => void sweepBlocksNow(), BLOCKS_EVERY_MS);
  blocksTimer?.unref?.();

  const offArchived = lean
    ? () => {}
    : onArchived((s) => {
        void retargetChildrenOf(sessionIdFor(s), stackDeps)
          .then((n) => n && broadcast('sessions-changed', { ts: Date.now() }))
          .catch((err) => logSwallowed('moving stacked sessions onto main', err));
        // A session others wait on is done.
        void sweepBlocksNow();
      });

  // Update from main (behind-main.ts): its numbers move, so look again.
  mountUpdateRoutes(app, {
    broadcast,
    changed: (id) => {
      behindCache.invalidate(id);
      diffStats.invalidate(id);
    },
  });

  // "Catch me up" on a session (catch-up.ts): its change size from the stats cache.
  const uncommittedFacts = (id: string) => {
    const d = diffStats.peek(id);
    return d ? { diff: { files: d.files, added: d.added, removed: d.deleted } } : {};
  };
  mountCatchUpRoutes(app, { facts: uncommittedFacts });
  // A session's history on one line (timeline.ts).
  mountTimelineRoutes(app, { ci: (id) => prWatch.state(id) });
  // Fork a session: a new branch from where it is, its Claude given a summary (fork.ts).
  mountForkRoutes(app, {
    broadcast,
    deps: defaultForkDeps({
      create: makeWorktree,
      summarize: async (s) =>
        (await catchUp(s, askCatchUp, catchUpFacts(sessionIdFor(s), uncommittedFacts(sessionIdFor(s)))))?.text ?? null,
      // Not computed yet: unknown (the prompt then says nothing about how many), never a made-up 0.
      uncommitted: (s) => diffStats.peek(sessionIdFor(s))?.files ?? null,
    }),
  });

  // Worktree mutations (create/remove/sync/rebase/open-editor). Each
  // emits sessions-changed so the sidebar refreshes.
  mountWorktreeRoutes(app, { broadcast, create: makeWorktree, releaseScope: (paths) => void scopeApi?.releaseSessionScope(paths, true) });

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
  statusNotify = mountStatusRoutes(app, {
    broadcast,
    onStatusChanged: (id) => {
      diffStats.invalidate(id);
      if (!lean) void syncStacksAfter(id);
      // Make sure this session's turns are checkpointed ("last turn" diffs)
      // from its first hook on, not only once someone opens it.
      const session = findSession(id);
      if (session) {
        sessionScope(session);
        syncConversationSoon(session);
      }
    },
  });

  // Ship (push / PR / merge) + archive.
  // Before an archive removes a worktree: close our watcher and any chat on it.
  const releaseSession = async (id: string) => {
    await disposeSessionWatcher(id);
    chatApi.stop(id);
    const s = findSession(id);
    if (s) scopeApi?.releaseSessionScope(s.paths, false);
  };
  mountShipRoutes(app, { broadcast, onRepoChanged: (id) => diffStats.invalidate(id), release: releaseSession, create: makeWorktree });

  // The sessions list's manual order (drag to reorder).
  mountSessionOrderRoutes(app, { broadcast });
  // The rail's pins and sections.
  mountRailRoutes(app, { broadcast });
  // Your notes on a session.
  mountNoteRoutes(app, { broadcast });
  // How the PTY host is doing (host-health.ts): the dashboard warns when it's slow or not answering.
  app.get('/api/pty-host/health', (c) => c.json(hostHealth(hostBeat()) satisfies HostHealth));
  let lastHostState = hostHealth(hostBeat()).state;
  const hostTick = lean
    ? null
    : setInterval(() => {
        const h = hostHealth(hostBeat());
        if (h.state === lastHostState) return;
        lastHostState = h.state;
        broadcast('host-health', h);
        if (h.state === 'unresponsive') report('warn', `[web] PTY host not answering: ${h.error ?? 'no reply'}`);
      }, 5_000);
  hostTick?.unref?.();
  // What a session waits on (and a look straight away: the blocker may be done already).
  mountBlockRoutes(app, { broadcast, changed: () => void sweepBlocksNow() });

  // A session's Claude as a chat: headless, instead of the terminal (spike).
  let selfUrl = '';
  const chatApi = mountChatRoutes(app, { baseUrl: () => selfUrl });

  app.get('/events', (c) => {
    const wantedSession = c.req.query('session');
    return streamSSE(c, async (stream) => {
      const listener = (e: SseEvent) => {
        stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }).catch(() => {
          /* */
        });
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
            .catch(() => {
              /* */
            });
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
      offArchived();
      if (blocksTimer) clearInterval(blocksTimer);
      if (hostTick) clearInterval(hostTick);
      loop.stop();
      jiraWatch.stop();
      if (decayTick) clearInterval(decayTick);
      stopPrWatch?.();
      if (sleepTimer) clearInterval(sleepTimer);
      if (conversationsTimer) clearInterval(conversationsTimer);
      if (conversationsFirst) clearTimeout(conversationsFirst);
      for (const t of conversationSyncs.values()) clearTimeout(t);
      chatApi.stopAll();
      clearTimeout(sweepTimer);
      activityWatcher?.stop();
      disposeAllWatchers();
      // Sweep checkpoint refs + manifests for every active scope BEFORE
      // wiping the registry — otherwise `refs/wd/<hash>/*` refs leak
      // across `work web` restarts and accumulate without bound in
      // every repo the user has reviewed.
      // Not the sessions' own scopes: their turn history outlives restarts.
      for (const scope of scopesToSweep(
        listScopes(),
        loadHistory().map((s) => s.paths),
      )) {
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
