import { Hono, type Context } from 'hono';
import { snoozeActive, snoozeFor, snoozeUntil, type Snooze } from '../../core/rail/snooze.js';
import { streamSSE } from 'hono/streaming';
import { WebSocketServer } from 'ws';
import { launch, type DiffServerHandle } from '../local-server.js';
import { refuseReason } from '../local-origin.js';
import { serveSpa } from '../spa-handler.js';
import { commentInputSchema } from '../../core/comments/comment-schemas.js';
import { DemoScenario, type DemoEvent } from './scenario.js';
import type {
  AnswerRequest,
  BranchCandidate,
  BuildFolderCandidate,
  CatchUpWire,
  CleanupApplyRequest,
  BlockerWire,
  HostHealth,
  TimelineWire,
  WorklogWire,
  ForkWire,
  JiraDecision,
  JiraWatchState,
  NoteWire,
  UpdateFromMainWire,
  WorkTimeWire,
  DiffSeen,
  SetupWire,
  UpdateWire,
  ReleaseNote,
} from '../../core/api-types.js';
import { dayKey } from '../../core/conversations/work-time-view.js';
import { DEFAULT_PROMPTS } from '../../core/sessions/saved-prompts.js';
import { buildStamp } from '../../core/platform/build-stamp.js';
import { cleanOrder } from '../../core/rail/session-order.js';
import { applyPlacePatch, applySectionOp, cleanPlacePatch, cleanSectionOp, type RailLayout } from '../../core/rail/rail-layout.js';
import { prUrl } from '../../core/rail/blocks.js';
import { buildTimeline } from '../../core/conversations/timeline.js';
import { createDemoActivity } from './demo-activity.js';
import { mountDemoReplies } from './demo-replies.js';
import { cleanStageRef } from '../../core/pr/pr-stage.js';
import { DemoRepoError } from './demo-repos.js';

/**
 * `work web --demo`: the real dashboard SPA against an in-memory API.
 *
 * Same routes and wire shapes as work web (api-types.ts), backed only by
 * DemoScenario — no git, no ~/.work, no PTY host, no Claude, no gh. That
 * makes it both a safe place for screenshots and UI work, and a standing
 * check that the UI depends only on the API contract (the architecture
 * test keeps this directory free of real I/O modules, and the contract test
 * checks every endpoint the SPA calls exists here).
 *
 * Actions have simulated effects: answering a blocked agent resumes it,
 * a comment gets a reply, Create PR opens one whose checks go green,
 * Merge merges, and the scripted day moves on while you watch.
 */

export interface DemoServerOptions {
  webRoot: string;
  scenario?: DemoScenario;
}

export async function startDemoServer(opts: DemoServerOptions): Promise<DiffServerHandle & { scenario: DemoScenario }> {
  const scenario = opts.scenario ?? new DemoScenario();
  const app = new Hono();
  const notFound = (c: { json: (b: unknown, s: 404) => Response }) => c.json({ error: 'unknown session' }, 404);
  const json = async (c: { req: { json: () => Promise<unknown> } }) =>
    ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  app.get('/api/context', (c) => c.json({ mode: 'dashboard', pid: process.pid, demo: true, lean: false, build: buildStamp() }));
  // The demo is not the singleton and has nothing to clean up; refuse.
  app.post('/api/shutdown', (c) => c.json({ error: 'the demo is stopped with Ctrl+C' }, 501));
  // Reply drafts on review threads (demo-replies.ts).
  const draftsFor = mountDemoReplies(app, scenario, (sessionId) => {
    broadcast({ event: 'replies-changed', data: { sessionId } });
    broadcast({ event: 'sessions-changed', data: { ts: Date.now() } });
  });
  // Update from main: nothing to update in the demo.
  app.post('/api/sessions/:id/update-from-main', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    return c.json({
      results: [{ ok: true, repo: w.target, how: 'nothing', base: 'origin/main', commits: 0 }],
    } satisfies UpdateFromMainWire);
  });

  // "Catch me up": a canned summary (the demo runs no Claude).
  const caughtUp = new Map<string, { text: string; at: string }>();
  // What a session waits on, in memory (a demo PR never merges; a session blocker is done when archived).
  const blocks = new Map<string, BlockerWire[]>();
  app.post('/api/sessions/:id/blocks', async (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    const body = await json(c);
    let ref: BlockerWire | null = null;
    if (body.kind === 'session' && typeof body.id === 'string') {
      const other = scenario.list().find((x) => x.id === body.id && !x.archivedAt);
      if (other && other.id !== w.id)
        ref = { key: `session:${other.id}`, kind: 'session', label: other.title ?? other.branch, sessionId: other.id };
    } else if (body.kind === 'pr' && typeof body.url === 'string') {
      const pr = prUrl(body.url);
      if (pr) ref = { key: `pr:${pr.url}`, kind: 'pr', label: pr.label, url: pr.url, state: 'OPEN' };
    }
    if (!ref)
      return c.json({ error: "expected {kind: 'session', id} of a live session, or {kind: 'pr', url} of a GitHub pull request" }, 400);
    blocks.set(w.id, [...(blocks.get(w.id) ?? []).filter((b) => b.key !== ref!.key), ref]);
    broadcast({ event: 'sessions-changed', data: { ts: Date.now() } });
    return c.json({ ok: true });
  });
  app.delete('/api/sessions/:id/blocks', (c) => {
    const key = c.req.query('key');
    const id = c.req.param('id');
    const left = key ? (blocks.get(id) ?? []).filter((b) => b.key !== key) : [];
    if (left.length) blocks.set(id, left);
    else blocks.delete(id);
    broadcast({ event: 'sessions-changed', data: { ts: Date.now() } });
    return c.json({ ok: true });
  });

  // The PTY host's heartbeat: the demo's never stalls.
  app.get('/api/pty-host/health', (c) => c.json({ state: 'ok', latencyMs: 4, quietMs: 1000, error: null } satisfies HostHealth));

  // Jira worklogs, simulated: set up, and a log is remembered (in memory).
  const worklogs = new Map<string, Record<string, number>>();
  app.get('/api/sessions/:id/worklog', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    return w
      ? c.json({ configured: true, issueKey: w.jiraKey ?? null, logged: worklogs.get(w.id) ?? {} } satisfies WorklogWire)
      : notFound(c);
  });
  app.post('/api/sessions/:id/worklog', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    if (!w.jiraKey) return c.json({ error: 'this session has no Jira issue' }, 409);
    const day = dayKey(scenario.clockMs());
    worklogs.set(w.id, { ...(worklogs.get(w.id) ?? {}), [day]: 3600 });
    return c.json({ ok: true, logged: 3600, total: 3600, text: `1h logged on ${w.jiraKey} for ${day}` });
  });

  // A session's timeline: built by the real buildTimeline from what the demo has.
  app.get('/api/sessions/:id/timeline', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    const t = scenario.clockMs();
    const iso = (minAgo: number) => new Date(t - minAgo * 60_000).toISOString();
    const events = buildTimeline({
      createdAt: w.createdAt,
      archivedAt: w.archivedAt,
      prompts: w.attention?.summary ? [{ ts: iso(50), text: w.attention.summary }] : [],
      checkpoints: (scenario.checkpoints(w.id) ?? []).map((e) => ({ id: e.id, ts: e.ts, label: e.label })),
      commits: [{ repo: w.target, sha: 'c0ffee1', at: iso(30), subject: `Work on ${w.branch}` }],
      prs: [],
    });
    return c.json({ events } satisfies TimelineWire);
  });

  // Your notes on a session, in memory.
  const notes = new Map<string, { text: string; updatedAt: string }>();
  app.get('/api/sessions/:id/note', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    return w ? c.json({ note: notes.get(w.id) ?? null } satisfies NoteWire) : notFound(c);
  });
  app.put('/api/sessions/:id/note', async (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    const body = await json(c);
    if (typeof body.text !== 'string') return c.json({ error: 'expected {text}' }, 400);
    if (body.text.trim()) notes.set(w.id, { text: body.text.slice(0, 20_000), updatedAt: new Date(scenario.clockMs()).toISOString() });
    else notes.delete(w.id);
    broadcast({ event: 'sessions-changed', data: { ts: Date.now() } });
    return c.json({ note: notes.get(w.id) ?? null } satisfies NoteWire);
  });

  // Time worked: a believable figure from the session's id (the demo keeps no transcripts).
  app.get('/api/sessions/:id/time', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    const seed = [...w.id].reduce((n, ch) => n + ch.charCodeAt(0), 0);
    const today = (20 + (seed % 70)) * 60_000;
    const yesterday = (seed % 3) * 25 * 60_000;
    const d = (offset: number) => dayKey(Date.now() - offset * 24 * 3_600_000);
    const byDay = [{ day: d(0), ms: today }, ...(yesterday ? [{ day: d(1), ms: yesterday }] : [])];
    return c.json({
      workedMs: today + yesterday,
      prompts: 3 + (seed % 9),
      byDay,
      firstAt: w.createdAt,
      lastAt: new Date().toISOString(),
    } satisfies WorkTimeWire);
  });
  app.get('/api/sessions/:id/catch-up', (c) => c.json({ catchUp: caughtUp.get(c.req.param('id')) ?? null } satisfies CatchUpWire));
  app.post('/api/sessions/:id/catch-up', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    const v = {
      text: `You asked Claude to work on ${w.branch}; ${w.attention?.summary ?? 'it made a first pass'}. Nothing is waiting on you right now; next is reviewing the diff and opening a PR.`,
      at: new Date().toISOString(),
    };
    caughtUp.set(w.id, v);
    return c.json({ catchUp: v } satisfies CatchUpWire);
  });

  // Snoozes, in memory, by the real rules (snooze.ts).
  const snoozes = new Map<string, Snooze>();
  // Live sessions; ?archived=1 adds the archived ones (as work web).
  app.get('/api/sessions', (c) =>
    c.json({
      sessions: scenario
        .list()
        .filter((w) => c.req.query('archived') === '1' || !w.archivedAt)
        .map((w) => {
          const out = draftsFor(w.id) ? { ...w, replyDrafts: draftsFor(w.id) } : { ...w };
          const z = snoozes.get(w.id);
          const waiting = (blocks.get(w.id) ?? []).filter(
            (b) => b.kind === 'pr' || scenario.list().some((x) => x.id === b.sessionId && !x.archivedAt),
          );
          const withBlocks = waiting.length ? { ...out, blockedBy: waiting } : out;
          const noted = notes.has(w.id) ? { ...withBlocks, hasNote: true } : withBlocks;
          return z && snoozeActive(z, noted) ? { ...noted, snoozed: { until: z.until } } : noted;
        }),
    }),
  );
  app.post('/api/sessions/:id/snooze', async (c) => {
    const body = await json(c);
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    let z: Snooze | null;
    if (typeof body.until === 'string') z = snoozeUntil(body.until, new Date(scenario.clockMs()));
    else if (body.for === '2h' || body.for === 'tomorrow' || body.for === 'change') z = snoozeFor(body.for, w);
    else return c.json({ error: "for: '2h', 'tomorrow' or 'change', or until: a time" }, 400);
    if (!z) return c.json({ error: 'not a time to snooze until: give one in the next 30 days' }, 400);
    snoozes.set(w.id, z);
    return c.json({ ok: true, snooze: z });
  });
  app.delete('/api/sessions/:id/snooze', (c) => {
    snoozes.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/sessions/:id/checkpoints', (c) => {
    const entries = scenario.checkpoints(c.req.param('id'));
    return entries ? c.json({ scopeHash: `demo-${c.req.param('id')}`, entries }) : notFound(c);
  });

  // How far you have looked at a session's diff: in memory, moving forward only (as diff-seen.ts).
  const diffSeen = new Map<string, DiffSeen>();
  app.get('/api/sessions/:id/diff-seen', (c) =>
    scenario.checkpoints(c.req.param('id')) ? c.json({ seen: diffSeen.get(c.req.param('id')) ?? null }) : notFound(c),
  );
  app.post('/api/sessions/:id/diff-seen', async (c) => {
    const id = c.req.param('id');
    if (!scenario.checkpoints(id)) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as { checkpointId?: unknown } | null;
    const cp = body?.checkpointId;
    if (typeof cp !== 'number' || !Number.isInteger(cp) || cp < 0) return c.json({ error: 'expected {checkpointId}' }, 400);
    const old = diffSeen.get(id);
    if (!old || old.checkpointId < cp) diffSeen.set(id, { checkpointId: cp, at: new Date().toISOString() });
    return c.json({ seen: diffSeen.get(id)! });
  });

  app.get('/api/sessions/:id/diff', (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from !== undefined && to !== undefined) {
      // 'working': up to the working tree, the newest there is.
      const d = scenario.rangeDiff(c.req.param('id'), Number(from), to === 'working' ? Number.MAX_SAFE_INTEGER : Number(to));
      return d ? c.json(d) : notFound(c);
    }
    const base = c.req.query('base') === 'branch' ? 'branch' : 'uncommitted';
    const d = scenario.diff(c.req.param('id'), base);
    return d ? c.json(d) : notFound(c);
  });

  app.get('/api/sessions/:id/ci', (c) => {
    const d = scenario.ci(c.req.param('id'));
    return d ? c.json(d) : notFound(c);
  });
  app.post('/api/sessions/:id/ci/fix', (c) => {
    const id = c.req.param('id');
    if (!scenario.ci(id)) return notFound(c);
    return scenario.fixCi(id) ? c.json({ ok: true }) : c.json({ error: 'no failing checks right now' }, 409);
  });

  app.get('/api/sessions/:id/dev', (c) => {
    const d = scenario.devState(c.req.param('id'));
    return d ? c.json(d) : notFound(c);
  });
  app.post('/api/sessions/:id/dev/start', (c) => {
    const id = c.req.param('id');
    if (!scenario.devState(id)) return notFound(c);
    return scenario.devStart(id)
      ? c.json({ ok: true, pid: scenario.devState(id)!.running!.pid })
      : c.json({ error: 'already running' }, 409);
  });
  app.post('/api/sessions/:id/dev/stop', (c) => {
    const id = c.req.param('id');
    if (!scenario.devState(id)) return notFound(c);
    return c.json({ ok: true, stopped: scenario.devStop(id) });
  });
  app.get('/api/sessions/:id/dev/log', (c) => {
    const d = scenario.devState(c.req.param('id'));
    if (!d) return notFound(c);
    return c.text(d.running ? `$ npm run dev   (PORT=${d.port})\n\n  VITE ready — Local: ${d.url}\n` : '(no output yet)');
  });

  app.post('/api/presence', async (c) => {
    const body = await json(c);
    if (typeof body.clientId !== 'string' || !body.clientId) return c.json({ error: 'clientId required' }, 400);
    if (body.gone) scenario.presence.drop(body.clientId);
    else
      scenario.presence.report({
        clientId: body.clientId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        visible: body.visible === true,
        focused: body.focused === true,
        canNotify: body.canNotify === true,
      });
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/revert', async (c) => {
    const body = await json(c);
    if (typeof body.repo !== 'string' || typeof body.path !== 'string') return c.json({ error: 'repo and path are required' }, 400);
    const lines = body.lines as { start?: unknown; end?: unknown } | undefined;
    const out = scenario.revert(c.req.param('id'), {
      repo: body.repo,
      path: body.path,
      lines: lines && typeof lines.start === 'number' && typeof lines.end === 'number' ? { start: lines.start, end: lines.end } : undefined,
    });
    return out.ok ? c.json(out) : c.json({ error: out.error }, out.status);
  });

  // -- comments (the real in-memory comment model) ---------------------------
  app.get('/api/sessions/:id/comments', (c) => {
    const store = scenario.comments(c.req.param('id'));
    return store ? c.json({ comments: store.snapshot() }) : notFound(c);
  });
  app.post('/api/sessions/:id/comments', async (c) => {
    const id = c.req.param('id');
    const store = scenario.comments(id);
    if (!store) return notFound(c);
    const parsed = commentInputSchema.safeParse(await json(c));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const comment = store.post(parsed.data);
    if (comment.author === 'user' && comment.status !== 'draft') scenario.replyLater(id, comment.id);
    broadcast({ event: 'comments-changed', data: { sessionId: id, id: comment.id } });
    return c.json({ comment, comments: store.snapshot() });
  });
  app.delete('/api/sessions/:id/comments/:cid', (c) => {
    const id = c.req.param('id');
    const store = scenario.comments(id);
    if (!store) return notFound(c);
    store.remove(c.req.param('cid'));
    broadcast({ event: 'comments-changed', data: { sessionId: id } });
    return c.json({ comments: store.snapshot() });
  });
  app.post('/api/sessions/:id/comments/:cid/resolve', async (c) => {
    const id = c.req.param('id');
    const store = scenario.comments(id);
    if (!store) return notFound(c);
    store.setResolved(c.req.param('cid'), (await json(c)).resolved === true);
    broadcast({ event: 'comments-changed', data: { sessionId: id } });
    return c.json({ comments: store.snapshot() });
  });
  app.post('/api/sessions/:id/submit-review', async (c) => {
    const id = c.req.param('id');
    const store = scenario.comments(id);
    if (!store) return notFound(c);
    const body = await json(c);
    const result = store.submit(typeof body.summary === 'string' ? body.summary : undefined);
    for (const d of result.drafts) scenario.replyLater(id, d.id);
    broadcast({ event: 'comments-changed', data: { sessionId: id } });
    return c.json({ count: result.drafts.length, comments: store.snapshot() });
  });
  app.post('/api/sessions/:id/discard-review', (c) => {
    const id = c.req.param('id');
    const store = scenario.comments(id);
    if (!store) return notFound(c);
    const discarded = store.discardDrafts();
    broadcast({ event: 'comments-changed', data: { sessionId: id } });
    return c.json({ discarded, comments: store.snapshot() });
  });

  // -- status / ship / archive -----------------------------------------------
  app.post('/api/sessions/:id/seen', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { prStage?: unknown } | null;
    const stage = cleanStageRef(body?.prStage);
    return scenario.markSeen(c.req.param('id'), stage?.key) ? c.json({ ok: true }) : notFound(c);
  });
  // Build folders in idle worktrees (simulated sizes; nothing on disk).
  let demoFolders: BuildFolderCandidate[] = [
    {
      sessionId: 'demo-web-fix-old-banner',
      target: 'web',
      branch: 'fix/old-banner',
      lastActive: new Date(Date.now() - 12 * 86_400_000).toISOString(),
      bytes: 812_000_000,
      folders: [
        { path: 'C:/worktrees/web/fix-old-banner/node_modules', bytes: 790_000_000 },
        { path: 'C:/worktrees/web/fix-old-banner/.next', bytes: 22_000_000 },
      ],
    },
  ];
  const folderState = () => ({
    scanning: false,
    checked: demoFolders.length,
    total: demoFolders.length,
    scannedAt: new Date().toISOString(),
    candidates: demoFolders,
  });
  app.get('/api/cleanup/build-folders', (c) => c.json(folderState()));
  app.post('/api/cleanup/build-folders/scan', (c) => c.json(folderState()));
  app.post('/api/cleanup/build-folders/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sessionIds?: unknown } | null;
    const ids = Array.isArray(body?.sessionIds) ? body.sessionIds.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ error: 'sessionIds: [...]' }, 400);
    const results = ids.map((id) => ({
      sessionId: id,
      ok: demoFolders.some((f) => f.sessionId === id),
      removed: 1,
      message: 'Removed (simulated)',
    }));
    demoFolders = demoFolders.filter((f) => !ids.includes(f.sessionId));
    return c.json({ results, state: folderState() });
  });

  // Naming a session: accepted, not kept (the demo names them after their prompt).
  app.post('/api/sessions/:id/title', (c) => c.json({ ok: true }));

  // Merged local branches (simulated).
  let demoBranches: BranchCandidate[] = [
    { repo: 'api', repoPath: 'C:/repos/api', branch: 'feat/old-export', tip: '0f3c2a91d4', reason: 'squash-merged', prNumber: 41 },
    { repo: 'web', repoPath: 'C:/repos/web', branch: 'fix/typo', tip: '9a1b2c3d4e', reason: 'merged' },
  ];
  const branchState = () => ({ scanning: false, scannedAt: new Date().toISOString(), candidates: demoBranches });
  app.get('/api/cleanup/branches', (c) => c.json(branchState()));
  app.post('/api/cleanup/branches/scan', (c) => c.json(branchState()));
  app.post('/api/cleanup/branches/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { items?: Array<{ repo: string; branch: string }> } | null;
    const items = Array.isArray(body?.items) ? body.items : [];
    if (items.length === 0) return c.json({ error: 'items: [{repo, branch}]' }, 400);
    demoBranches = demoBranches.filter((b) => !items.some((i) => i.repo === b.repo && i.branch === b.branch));
    return c.json({
      results: items.map((i) => ({ repo: i.repo, branch: i.branch, ok: true, message: 'Deleted (simulated)' })),
      state: branchState(),
    });
  });

  // Search in kept conversations: the demo keeps none.
  app.get('/api/conversations/search', (c) => c.json({ hits: [] }));

  // The sessions list's manual order, in memory.
  let sessionOrder: string[] = [];
  app.get('/api/session-order', (c) => c.json({ order: sessionOrder }));
  app.put('/api/session-order', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { order?: unknown } | null;
    const order = cleanOrder(body?.order);
    if (!order) return c.json({ error: 'order must be an array of session ids' }, 400);
    sessionOrder = order;
    return c.json({ order });
  });

  // The rail's pins and sections, in memory, by the real rules (rail-layout.ts).
  let rail: RailLayout = { sections: [], places: {} };
  const railChanged = () => broadcast({ event: 'rail-changed', data: { ts: Date.now() } });
  app.get('/api/rail', (c) => c.json(rail));
  app.post('/api/rail/sections', async (c) => {
    const op = cleanSectionOp(await json(c));
    if (!op) return c.json({ error: 'expected {op: add|rename|move|remove, id, name?, by?}' }, 400);
    const r = applySectionOp(rail.sections, op);
    if (!r.ok) return c.json({ error: r.error }, 409);
    const sections = r.sections;
    const known = new Set(sections.map((s) => s.id));
    const places: RailLayout['places'] = {};
    for (const [id, p] of Object.entries(rail.places)) {
      const next = p.section && !known.has(p.section) ? applyPlacePatch(p, { section: null }) : p;
      if (next) places[id] = next;
    }
    rail = { sections, places };
    railChanged();
    return c.json(rail);
  });
  app.put('/api/sessions/:id/rail', async (c) => {
    const id = c.req.param('id');
    if (!scenario.list().some((x) => x.id === id)) return notFound(c);
    const patch = cleanPlacePatch(await json(c));
    if (!patch) return c.json({ error: 'expected {pinned?: boolean, section?: string | null}' }, 400);
    if (patch.section && !rail.sections.some((s) => s.id === patch.section)) return c.json({ error: 'no such section' }, 409);
    const places = { ...rail.places };
    const next = applyPlacePatch(places[id], patch);
    if (next) places[id] = next;
    else delete places[id];
    rail = { ...rail, places };
    railChanged();
    return c.json(rail);
  });

  // Driving a session from outside (session-control-routes.ts): a message is a published comment, as for real.
  app.post('/api/sessions/:id/send', async (c) => {
    const id = c.req.param('id');
    const store = scenario.comments(id);
    if (!store) return notFound(c);
    const body = await json(c);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'the message is empty' }, 400);
    const comment = store.post({ side: 'general', status: 'published', body: text });
    scenario.replyLater(id, comment.id);
    broadcast({ event: 'comments-changed', data: { sessionId: id, id: comment.id } });
    return c.json({ how: 'typed', sentAt: new Date(scenario.clockMs()).toISOString() });
  });
  app.post('/api/sessions/:id/agent/start', (c) => (scenario.comments(c.req.param('id')) ? c.json({ how: 'running' }) : notFound(c)));
  app.post('/api/sessions/:id/agent/stop', (c) => (scenario.comments(c.req.param('id')) ? c.json({ how: 'stopped' }) : notFound(c)));
  app.get('/api/sessions/:id/screen', (c) =>
    scenario.comments(c.req.param('id')) ? c.json({ text: scenario.screen(c.req.param('id')) }) : notFound(c),
  );

  app.post('/api/sessions/:id/answer', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<AnswerRequest> | null;
    if (!body || (body.answer !== 'allow' && body.answer !== 'deny')) return c.json({ error: 'answer must be allow or deny' }, 400);
    const error = scenario.answer(c.req.param('id'), body.answer, body.request);
    return error ? c.json({ error }, 409) : c.json({ ok: true });
  });
  app.get('/api/sessions/:id/ship', (c) => {
    const p = scenario.preflight(c.req.param('id'));
    return p ? c.json(p) : notFound(c);
  });
  app.post('/api/sessions/:id/ship', async (c) => {
    const id = c.req.param('id');
    const body = await json(c);
    if (body.action === 'merge') {
      const repos = Array.isArray(body.repos) ? (body.repos as Array<{ name: string; headSha: string }>) : null;
      if (!repos?.length) return c.json({ error: 'merge needs repos: [{ name, headSha }] — the PR heads you reviewed' }, 400);
      const method = body.method === 'merge' || body.method === 'rebase' ? body.method : 'squash';
      const out = scenario.merge(id, repos, method);
      return out ? c.json(out) : notFound(c);
    }
    if (body.action !== 'push' && body.action !== 'create-pr') return c.json({ error: 'action must be push, create-pr or merge' }, 400);
    const results = scenario.ship(id, body.action, body.draft === true);
    return results ? c.json({ results, archived: false }) : notFound(c);
  });
  app.post('/api/sessions/:id/archive', async (c) => {
    const body = await json(c);
    if (typeof body.archived !== 'boolean') return c.json({ error: 'archived (boolean) required' }, 400);
    return scenario.setArchived(c.req.param('id'), body.archived) ? c.json({ ok: true }) : notFound(c);
  });

  // -- worktree actions (simulated) -----------------------------------------
  // Onto main once its parent merged: the demo has no real stacks to move, so it just says it did.
  app.post('/api/sessions/:id/retarget', (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    if (!w.stackParentMerged) return c.json({ error: 'it is not stacked on a merged session' }, 409);
    scenario.retarget(w.id);
    return c.json({ results: [{ ok: true, repo: w.target, how: 'rebase', base: 'origin/main', commits: 3 }] } satisfies UpdateFromMainWire);
  });

  // Fork: a new demo session on the new branch, started with a canned summary.
  app.post('/api/sessions/:id/fork', async (c) => {
    const w = scenario.list().find((x) => x.id === c.req.param('id'));
    if (!w) return notFound(c);
    const body = await json(c);
    const branch = typeof body.branch === 'string' ? body.branch.trim() : '';
    if (!branch || branch === w.branch) return c.json({ error: 'the fork needs a branch of its own' }, 400);
    if (scenario.list().some((x) => x.target === w.target && x.branch === branch))
      return c.json({ error: `${branch} already exists: pick another name` }, 409);
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim()
        ? body.prompt.trim()
        : `Forked from ${w.branch}: read the summary and wait for my instruction.`;
    const s = scenario.create(w.target, branch, prompt, w.branch);
    return c.json({ sessionId: s.id, paths: s.paths, summarized: true } satisfies ForkWire);
  });

  app.post('/api/worktrees', async (c) => {
    const body = await json(c);
    if (typeof body.target !== 'string' || !body.target) return c.json({ error: 'target is required' }, 400);
    // No branch: the repo as it is (its default branch, in the demo).
    const branch = typeof body.branch === 'string' && body.branch.trim() ? body.branch.trim() : 'main';
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : undefined;
    const s = scenario.create(body.target, branch, prompt);
    return c.json({ sessionId: s.id, launchDir: s.paths[0], paths: s.paths, ...(prompt ? { started: 'started' } : {}) });
  });
  app.delete('/api/sessions/:id/worktree', (c) =>
    scenario.remove(c.req.param('id')) ? c.json({ ok: true, worktreeRemoved: true }) : notFound(c),
  );
  app.post('/api/sessions/:id/sync', (c) => c.json({ results: [{ path: 'demo', fetched: true, pulled: true }] }));
  app.post('/api/sessions/:id/rebase', (c) => c.json({ results: [{ path: 'demo', ok: true, parent: 'origin/main' }] }));
  const noLocalApps = (c: { json: (b: unknown, s: 501) => Response }) =>
    c.json({ error: 'Demo mode: opening local apps is simulated — there is no real worktree.' }, 501);
  app.post('/api/sessions/:id/open-editor', (c) => noLocalApps(c));
  app.post('/api/sessions/:id/open-terminal', (c) => noLocalApps(c));
  app.get('/api/sessions/:id/terminal/health', (c) => c.json({ ok: true }));

  // -- side panes --------------------------------------------------------------
  app.get('/api/projects', (c) => c.json(scenario.projects()));

  // The Repos page: a pretend ~/repos, changed in memory by the real rules (demo-repos.ts).
  const repoModel = scenario.repos;
  const repoAnswer = (c: Context, fn: () => void) => {
    try {
      fn();
      broadcast({ event: 'repos-changed', data: { ts: Date.now() } });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof DemoRepoError) return c.json({ error: err.message, sessions: err.sessions }, err.sessions.length ? 409 : 400);
      throw err;
    }
  };
  const repoBody = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  app.get('/api/repos', (c) => c.json(repoModel.inventory()));
  app.post('/api/repos', async (c) => {
    const b = await repoBody(c);
    if (typeof b.alias !== 'string' || typeof b.path !== 'string') return c.json({ error: 'expected {alias, path}' }, 400);
    return repoAnswer(c, () => repoModel.enroll(b.alias as string, b.path as string));
  });
  app.delete('/api/repos/:alias', (c) => repoAnswer(c, () => repoModel.remove(c.req.param('alias'), c.req.query('force') === '1')));
  app.post('/api/repos/ignore', async (c) => {
    const b = await repoBody(c);
    if (typeof b.path !== 'string' || typeof b.ignored !== 'boolean') return c.json({ error: 'expected {path, ignored}' }, 400);
    return repoAnswer(c, () => repoModel.ignore(b.path as string, b.ignored as boolean));
  });
  app.post('/api/repos/roots', (c) => c.json({ error: 'Demo mode: the scanned folder is pretend, ~/repos only.' }, 400));
  app.post('/api/groups', async (c) => {
    const b = await repoBody(c);
    const members = Array.isArray(b.members) ? b.members.filter((m): m is string => typeof m === 'string') : null;
    if (typeof b.name !== 'string' || !members) return c.json({ error: 'expected {name, members, creating}' }, 400);
    return repoAnswer(c, () => repoModel.saveGroup(b.name as string, members, b.creating === true));
  });
  app.delete('/api/groups/:name', (c) => repoAnswer(c, () => repoModel.deleteGroup(c.req.param('name'), c.req.query('force') === '1')));
  // Updates: the demo is current, with two releases' notes to read.
  const demoNotes: ReleaseNote[] = [
    {
      version: '2.1.0',
      name: 'work 2.1.0',
      body: '## In review\n\nA pull request waiting on reviewers keeps its session out of the Inbox; it comes back when it is **approved**, conflicts or fails its checks.\n\n- Jira has its own tab again\n- PR pills on the session list\n- `work move` takes your sessions to another computer',
      publishedAt: '2026-10-05T09:00:00Z',
      url: 'https://github.com/moberghr/cli-work-tree-manager/releases/tag/v2.1.0',
    },
    {
      version: '2.0.0',
      name: 'work 2.0.0',
      body: 'The PTY host: Claudes survive restarts.\n\n- `work attach`\n- the browser dashboard replaces `work dash`',
      publishedAt: '2026-09-20T09:00:00Z',
      url: 'https://github.com/moberghr/cli-work-tree-manager/releases/tag/v2.0.0',
    },
  ];
  let demoSeen = '2.1.0';
  const demoUpdates = (): UpdateWire => ({
    running: '2.1.0',
    install: 'desktop',
    latest: '2.1.0',
    checkedAt: new Date(scenario.clockMs()).toISOString(),
    checkError: null,
    desktop: { appVersion: '2.1.0', state: 'current' },
    available: null,
    whatsNew: demoSeen === '2.1.0' ? null : '2.1.0',
  });
  app.get('/api/updates', (c) => c.json(demoUpdates()));
  app.post('/api/updates/check', (c) => c.json(demoUpdates()));
  app.post('/api/updates/restart', (c) => c.json({ error: 'No downloaded update to restart into.' }, 409));
  app.get('/api/updates/notes', (c) => c.json({ releases: demoNotes, checkError: null }));
  app.post('/api/updates/seen', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
    if (typeof b?.version !== 'string') return c.json({ error: 'expected {version}' }, 400);
    demoSeen = b.version;
    return c.json({ ok: true });
  });

  // First run: the demo is set up already (its folders are pretend).
  app.get('/api/setup', (c) =>
    c.json({
      configured: true,
      worktreesRoot: '~/worktrees',
      reposFolder: '~/repos',
      repos: repoModel.projects().singles.length,
      sessions: scenario.list().filter((w) => !w.archivedAt).length,
      suggested: { reposFolder: '~/repos', worktreesRoot: '~/worktrees' },
      tools: [
        { id: 'git', label: 'git', needed: true, ok: true, detail: 'git version 2.47.0' },
        { id: 'claude', label: 'Claude Code', needed: true, ok: true, detail: '2.1.0 (Claude Code)' },
        { id: 'gh', label: 'GitHub CLI', needed: false, ok: true, detail: 'Logged in to github.com' },
        {
          id: 'acli',
          label: 'Atlassian CLI',
          needed: false,
          ok: false,
          detail: 'Optional: install acli to start sessions from your Jira issues.',
        },
      ],
    } satisfies SetupWire),
  );
  app.post('/api/setup', (c) => c.json({ error: 'Demo mode: the folders are pretend.' }, 400));
  app.get('/api/branch-check', (c) => {
    const target = c.req.query('target') ?? '';
    const branch = c.req.query('branch') ?? '';
    if (!target.trim() || !branch.trim()) return c.json({ error: 'target and branch required' }, 400);
    return c.json(scenario.branchCheck(target.trim(), branch.trim()));
  });
  app.get('/api/prompts', (c) => c.json({ prompts: DEFAULT_PROMPTS, configured: false }));
  app.post('/api/assistant/context', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { tab?: unknown; sessionId?: unknown } | null;
    if (!body || typeof body.tab !== 'string') return c.json({ error: 'tab required' }, 400);
    scenario.setAssistantView(`the ${body.tab} tab${typeof body.sessionId === 'string' ? ` (session ${body.sessionId})` : ''}`);
    return c.json({ ok: true });
  });
  app.get('/api/cleanup', (c) => c.json(scenario.cleanup()));
  app.post('/api/cleanup/scan', (c) => c.json(scenario.cleanupScan()));
  app.post('/api/cleanup/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<CleanupApplyRequest> | null;
    if (!Array.isArray(body?.items) || body.items.length === 0) return c.json({ error: 'items required' }, 400);
    return c.json(scenario.cleanupApply(body.items));
  });
  app.get('/api/digest', (c) => {
    const asked = Date.parse(c.req.query('since') ?? '');
    return c.json(scenario.digest(Number.isFinite(asked) ? asked : Date.now() - 24 * 3_600_000));
  });
  // What work would be doing in the background (demo-activity.ts).
  let activityTimer: NodeJS.Timeout | null = null;
  const activity = createDemoActivity(scenario, () => {
    activityTimer ??= setTimeout(() => {
      activityTimer = null;
      broadcast({ event: 'activity-changed', data: { ts: Date.now() } });
    }, 400);
  });
  app.get('/api/activity', (c) => c.json(activity.log.snapshot()));
  app.get('/api/prs', (c) => c.json({ prs: scenario.prs() }));
  app.get('/api/jira', (c) => c.json({ available: true, issues: scenario.jira() }));

  // The Jira watch, in memory: the switch works; nothing is ever started.
  let jiraWatch: JiraWatchState['settings'] = { enabled: false, since: null };
  const jiraDecisions: JiraDecision[] = [];
  app.get('/api/jira/watch', (c) =>
    c.json({
      settings: jiraWatch,
      decisions: jiraDecisions,
      targets: [...new Set([...scenario.sessions.values()].map((s) => s.target))],
      lastRunAt: null,
      nextRunAt: null,
    } satisfies JiraWatchState),
  );
  app.put('/api/jira/watch', async (c) => {
    const body = await json(c);
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (true/false) required' }, 400);
    jiraWatch = { enabled: body.enabled, since: body.enabled ? new Date().toISOString() : null };
    return c.json({ settings: jiraWatch });
  });
  app.post('/api/jira/watch/:key/start', (c) => c.json({ error: 'the demo starts nothing' }, 400));
  app.post('/api/jira/watch/:key/dismiss', (c) => {
    const d = jiraDecisions.find((x) => x.key === c.req.param('key'));
    if (!d) return c.json({ error: 'no such issue' }, 404);
    d.action = 'dismissed';
    return c.json({ ok: true });
  });
  app.get('/api/tasks', (c) => c.json({ tasks: scenario.taskList() }));
  app.post('/api/tasks', async (c) => {
    const body = await json(c);
    return typeof body.text === 'string' && body.text.trim()
      ? c.json({ tasks: scenario.addTask(body.text.trim()) })
      : c.json({ error: 'text required' }, 400);
  });
  app.patch('/api/tasks/:id', async (c) => {
    const body = await json(c);
    const patch: { text?: string; done?: boolean } = {};
    if (typeof body.text === 'string') patch.text = body.text;
    if (typeof body.done === 'boolean') patch.done = body.done;
    return c.json({ tasks: scenario.updateTask(Number(c.req.param('id')), patch) });
  });
  app.delete('/api/tasks/:id', (c) => c.json({ tasks: scenario.deleteTask(Number(c.req.param('id'))) }));

  // -- live updates ------------------------------------------------------------
  const listeners = new Set<(e: DemoEvent) => void>();
  function broadcast(e: DemoEvent): void {
    for (const cb of listeners) cb(e);
  }
  const unsubscribe = scenario.subscribe(broadcast);
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const cb = (e: DemoEvent) => {
        stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }).catch(() => {
          /* client gone */
        });
      };
      listeners.add(cb);
      await stream.writeSSE({ event: 'connected', data: '' });
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          listeners.delete(cb);
          resolve();
        }),
      );
    }),
  );

  app.get('*', (c) => serveSpa(c, opts.webRoot));

  const handle = await launch(app);
  const tick = setInterval(() => scenario.tick(), 500);
  tick.unref?.();

  // -- simulated terminal ------------------------------------------------------
  // Same framing as the real bridge: a replay frame first, binary output,
  // JSON input/resize from the browser.
  const wss = new WebSocketServer({ noServer: true });
  handle.httpServer.on('upgrade', (req, socket, head) => {
    const m = (req.url ?? '').match(/^\/ws\/sessions\/([^/]+)\/terminal$/);
    const reason = refuseReason({ method: 'GET', upgrade: true, host: req.headers.host, origin: req.headers.origin }, handle.port);
    if (!m || reason) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'replay', data: scenario.screen(id), cols: 120, rows: 32 }));
      const off = scenario.onTerminal(id, (data) => {
        try {
          ws.send(Buffer.from(data), { binary: true });
        } catch {
          /* closed */
        }
      });
      let line = '';
      ws.on('message', (raw) => {
        let msg: { type?: string; data?: string };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type !== 'input' || typeof msg.data !== 'string') return;
        for (const ch of msg.data) {
          if (ch === '\r') {
            scenario.input(id, line);
            line = '';
          } else if (ch === '\x7f') {
            if (line) {
              line = line.slice(0, -1);
              ws.send(Buffer.from('\b \b'), { binary: true });
            }
          } else if (ch >= ' ') {
            line += ch;
            ws.send(Buffer.from(ch), { binary: true });
          }
        }
      });
      ws.on('close', off);
    });
  });

  return {
    ...handle,
    scenario,
    async stop() {
      clearInterval(tick);
      activity.stop();
      unsubscribe();
      wss.close();
      await handle.stop();
    },
  };
}
