import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { WebSocketServer } from 'ws';
import { launch, type DiffServerHandle } from '../local-server.js';
import { refuseReason } from '../local-origin.js';
import { serveSpa } from '../spa-handler.js';
import { commentInputSchema } from '../comment-schemas.js';
import { DemoScenario, type DemoEvent } from './scenario.js';
import type { AnswerRequest, CleanupApplyRequest } from '../api-types.js';
import { DEFAULT_PROMPTS } from '../saved-prompts.js';
import { buildStamp } from '../build-stamp.js';

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
  app.get('/api/sessions', (c) => c.json({ sessions: scenario.list() }));

  app.get('/api/sessions/:id/checkpoints', (c) => {
    const entries = scenario.checkpoints(c.req.param('id'));
    return entries ? c.json({ scopeHash: `demo-${c.req.param('id')}`, entries }) : notFound(c);
  });

  app.get('/api/sessions/:id/diff', (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from !== undefined && to !== undefined) {
      const d = scenario.rangeDiff(c.req.param('id'), Number(from), Number(to));
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
    return scenario.devStart(id) ? c.json({ ok: true, pid: scenario.devState(id)!.running!.pid }) : c.json({ error: 'already running' }, 409);
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
  app.post('/api/sessions/:id/seen', (c) => (scenario.markSeen(c.req.param('id')) ? c.json({ ok: true }) : notFound(c)));
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
  app.post('/api/worktrees', async (c) => {
    const body = await json(c);
    if (typeof body.target !== 'string' || typeof body.branch !== 'string' || !body.branch) {
      return c.json({ error: 'target and branch are required' }, 400);
    }
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : undefined;
    const s = scenario.create(body.target, body.branch, prompt);
    return c.json({ sessionId: s.id, launchDir: s.paths[0], paths: s.paths, ...(prompt ? { started: 'started' } : {}) });
  });
  app.delete('/api/sessions/:id/worktree', (c) =>
    scenario.remove(c.req.param('id')) ? c.json({ ok: true, worktreeRemoved: true }) : notFound(c),
  );
  app.post('/api/sessions/:id/sync', (c) =>
    c.json({ results: [{ path: 'demo', fetched: true, pulled: true }] }),
  );
  app.post('/api/sessions/:id/rebase', (c) =>
    c.json({ results: [{ path: 'demo', ok: true, parent: 'origin/main' }] }),
  );
  const noLocalApps = (c: { json: (b: unknown, s: 501) => Response }) =>
    c.json({ error: 'Demo mode: opening local apps is simulated — there is no real worktree.' }, 501);
  app.post('/api/sessions/:id/open-editor', (c) => noLocalApps(c));
  app.post('/api/sessions/:id/open-terminal', (c) => noLocalApps(c));
  app.get('/api/sessions/:id/terminal/health', (c) => c.json({ ok: true }));

  // -- side panes --------------------------------------------------------------
  app.get('/api/projects', (c) => c.json(scenario.projects()));
  app.get('/api/prompts', (c) => c.json({ prompts: DEFAULT_PROMPTS, configured: false }));
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
  app.get('/api/prs', (c) => c.json({ prs: scenario.prs() }));
  app.get('/api/jira', (c) => c.json({ available: true, issues: scenario.jira() }));
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
        stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) }).catch(() => { /* client gone */ });
      };
      listeners.add(cb);
      await stream.writeSSE({ event: 'connected', data: '' });
      await new Promise<void>((resolve) => stream.onAbort(() => {
        listeners.delete(cb);
        resolve();
      }));
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
    const reason = refuseReason(
      { method: 'GET', upgrade: true, host: req.headers.host, origin: req.headers.origin },
      handle.port,
    );
    if (!m || reason) {
      socket.destroy();
      return;
    }
    const id = decodeURIComponent(m[1]);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'replay', data: scenario.screen(id), cols: 120, rows: 32 }));
      const off = scenario.onTerminal(id, (data) => {
        try { ws.send(Buffer.from(data), { binary: true }); } catch { /* closed */ }
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
      unsubscribe();
      wss.close();
      await handle.stop();
    },
  };
}
