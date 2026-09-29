import path from 'node:path';
import type { Hono } from 'hono';
import { loadConfig } from './config.js';
import { findSessionForCwd } from './pending-delivery.js';
import { sessionIdFor, findSession } from './web-state.js';
import { markSeen, notifyKindForTransition, readStatus, recordStatusEvent } from './session-status.js';
import { ANSWER_KEYS, checkDialog } from './permission-request.js';
import { readPtyScreen, writeToPty } from './pty-pool.js';
import { notifyDesktop } from './notifier.js';
import { runStatusHooks } from './status-hooks.js';
import { createPresence, type Presence } from './presence.js';
import type { AnswerRequest, NotifyEvent, PresenceReport } from './api-types.js';

export interface StatusRoutesOptions {
  broadcast: (event: string, data: unknown) => void;
  /** A session's Claude changed state (usually: a turn ended, files moved). */
  onStatusChanged?: (sessionId: string) => void;
  /** Who's watching (tests inject one with a fake clock). */
  presence?: Presence;
  /** The session's PTY in the host (tests inject a fake screen). */
  pty?: {
    screen: (sessionId: string) => Promise<string | null>;
    write: (sessionId: string, data: string) => Promise<boolean>;
  };
}

/** Why an answer was not typed, in words for the inbox. */
const DIALOG_REFUSALS = {
  'no-dialog': 'The permission prompt is no longer on screen — it was answered already.',
  'other-request': 'The prompt on screen is about something else now. Look again before answering.',
  'not-default': '"Yes" is not the highlighted choice on screen (someone moved it in the terminal). Answer it there.',
} as const;

/**
 * Attention inbox routes.
 *
 *   POST /api/status-changed      {cwd} — nudge from `work hook status-*`
 *                                  after it recorded a Claude hook event
 *   POST /api/sessions/:id/seen   — the user opened the session
 *   POST /api/presence            — a dashboard tab reports what it shows
 *   POST /api/sessions/:id/answer — Allow / Deny a permission prompt
 *
 * Notifications go where the user will see them, and only when they're
 * not already looking: nothing if a focused tab shows that session; a
 * click-to-jump browser notification (SSE `notify`) if a dashboard tab can
 * raise one; the desktop toast only when no dashboard can.
 *
 * Status itself lives in ~/.work/status/ (written by the hook process), so a
 * missed nudge only delays the dashboard until its next refresh.
 */
export function mountStatusRoutes(app: Hono, opts: StatusRoutesOptions): void {
  // Guards against a nudge replayed for the same write (e.g. two hooks
  // racing) notifying twice: remember the last status write we acted on.
  const lastNotified = new Map<string, string>();
  const presence = opts.presence ?? createPresence();

  app.post('/api/status-changed', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cwd?: unknown };
    if (typeof body.cwd !== 'string') return c.json({ error: 'cwd required' }, 400);
    const session = findSessionForCwd(body.cwd);
    if (!session) return c.json({ ok: true, matched: false });
    const id = sessionIdFor(session);
    opts.onStatusChanged?.(id);
    const status = readStatus(id);
    if (status && lastNotified.get(id) !== status.updatedAt) {
      lastNotified.set(id, status.updatedAt);
      const kind = notifyKindForTransition(
        status.prevState ? { state: status.prevState } : null,
        status,
      );
      if (kind) {
        const config = loadConfig();
        const launchDir = session.isGroup && session.paths[0]
          ? path.dirname(session.paths[0])
          : session.paths[0] ?? body.cwd;
        const name = `${session.target} · ${session.branch}`;
        const route = presence.route(id);
        if (route !== 'none') {
          const event: NotifyEvent = {
            sessionId: id,
            kind,
            title: `${kind === 'needs_input' ? 'Needs your input' : 'Finished'} — ${name}`,
            body: status.summary,
          };
          opts.broadcast('notify', event);
        }
        if (route === 'os') notifyDesktop(name, kind, { enabled: config?.notifications === true });
        // The user's own hooks are theirs to filter — they always run.
        runStatusHooks(kind, launchDir, name, config?.statusHooks);
      }
    }
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true, matched: true, sessionId: id });
  });

  app.post('/api/presence', async (c) => {
    // sendBeacon (tab closing) posts text/plain — parse the body either way.
    const body = (await c.req.json().catch(() => null)) as Partial<PresenceReport> | null;
    if (!body || typeof body.clientId !== 'string' || !body.clientId) return c.json({ error: 'clientId required' }, 400);
    if (body.gone) presence.drop(body.clientId);
    else
      presence.report({
        clientId: body.clientId,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
        visible: body.visible === true,
        focused: body.focused === true,
        canNotify: body.canNotify === true,
      });
    return c.json({ ok: true });
  });

  const pty = opts.pty ?? { screen: readPtyScreen, write: writeToPty };

  // Answering types into Claude's terminal, so it only happens when the
  // screen shows exactly the prompt the user was shown, with Yes
  // highlighted: Enter then means "Yes", Esc means "No". Anything else is
  // refused with the reason, and the user answers in the terminal.
  app.post('/api/sessions/:id/answer', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const body = (await c.req.json().catch(() => null)) as Partial<AnswerRequest> | null;
    if (!body || (body.answer !== 'allow' && body.answer !== 'deny')) {
      return c.json({ error: 'answer must be allow or deny' }, 400);
    }
    const status = readStatus(id);
    const req = status?.state === 'needs_input' ? status.request : undefined;
    if (!req) return c.json({ error: 'Nothing to answer — it has moved on.' }, 409);
    if (body.request?.tool !== req.tool || body.request?.detail !== req.detail) {
      return c.json({ error: 'The request changed since you saw it. Look again before answering.' }, 409);
    }
    const screen = await pty.screen(id);
    if (screen === null) {
      return c.json({ error: 'This Claude is not running in the PTY host, so it can only be answered in its own terminal.' }, 409);
    }
    const check = checkDialog(screen, req);
    if (!check.ok) return c.json({ error: DIALOG_REFUSALS[check.reason] }, 409);
    if (!(await pty.write(id, ANSWER_KEYS[body.answer]))) {
      return c.json({ error: 'Could not reach the session terminal.' }, 409);
    }
    await recordStatusEvent(id, { kind: 'answered', answer: body.answer });
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/seen', async (c) => {
    const id = c.req.param('id');
    if (!findSession(id)) return c.json({ error: 'unknown session' }, 404);
    const status = await markSeen(id);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true, status });
  });
}
