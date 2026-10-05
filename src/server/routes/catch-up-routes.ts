import type { Hono } from 'hono';
import { findSession } from '../../core/sessions/web-state.js';
import { cachedCatchUp, catchUp, type CatchUpFacts } from '../../core/conversations/catch-up.js';
import { askCatchUp, catchUpFacts } from '../../core/conversations/catch-up-deps.js';
import type { CatchUpWire, WorklogWire, WorkTimeWire } from '../../core/api-types.js';
import { jiraWorklogPoster, loggedDays, logWorkDay, worklogSettings, type WorklogSettings } from '../../core/jira/jira-worklog.js';
import { loadConfig } from '../../core/platform/config.js';
import { sessionWorkTime } from '../../core/conversations/work-time-source.js';

/**
 * "Catch me up" (catch-up.ts), for the session header:
 *
 *   GET  /api/sessions/:id/time      — how long its Claude worked (work-time.ts)
 *   GET  /api/sessions/:id/catch-up  — the last summary, if the conversation hasn't grown (runs nothing)
 *   POST /api/sessions/:id/catch-up  — write one (an internal Claude, no tools)
 */
export function mountCatchUpRoutes(
  app: Hono,
  opts: {
    ask?: (prompt: string) => Promise<string | null>;
    facts?: (id: string) => CatchUpFacts;
    /** Sends one worklog (tests swap it; default: Jira's REST API). */
    postWorklog?: (
      s: WorklogSettings,
    ) => (issueKey: string, body: { timeSpentSeconds: number; started: string; comment: unknown }) => Promise<string>;
  } = {},
): void {
  const ask = opts.ask ?? askCatchUp;
  const facts = (id: string): CatchUpFacts => catchUpFacts(id, opts.facts?.(id));

  // How long its Claude worked (work-time.ts): reads the transcripts (only what's new since the last look).
  app.get('/api/sessions/:id/time', async (c) => {
    const s = findSession(c.req.param('id'));
    if (!s) return c.json({ error: 'unknown session' }, 404);
    return c.json((await sessionWorkTime(s)) satisfies WorkTimeWire);
  });

  // Jira worklogs of its time (jira-worklog.ts): what was logged, and log a day.
  app.get('/api/sessions/:id/worklog', (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    const logged = Object.fromEntries(Object.entries(loggedDays(id)).map(([day, l]) => [day, l.seconds]));
    return c.json({ configured: !!worklogSettings(loadConfig()), issueKey: s.jiraKey ?? null, logged } satisfies WorklogWire);
  });
  app.post('/api/sessions/:id/worklog', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    const settings = worklogSettings(loadConfig());
    if (!settings)
      return c.json({ error: 'Jira worklogs are not set up (config jiraWorklog: site, email, and an API token in JIRA_API_TOKEN).' }, 409);
    if (!s.jiraKey) return c.json({ error: 'this session has no Jira issue' }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { day?: unknown };
    const time = await sessionWorkTime(s);
    const day = typeof body.day === 'string' ? time.byDay.find((d) => d.day === body.day) : time.byDay[0];
    if (!day) return c.json({ error: 'no work that day to log' }, 409);
    const r = await logWorkDay(id, s.jiraKey, day.day, day.ms, opts.postWorklog?.(settings) ?? jiraWorklogPoster(settings));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json(r);
  });

  app.get('/api/sessions/:id/catch-up', (c) => {
    const s = findSession(c.req.param('id'));
    if (!s) return c.json({ error: 'unknown session' }, 404);
    return c.json({ catchUp: cachedCatchUp(s) } satisfies CatchUpWire);
  });

  app.post('/api/sessions/:id/catch-up', async (c) => {
    const id = c.req.param('id');
    const s = findSession(id);
    if (!s) return c.json({ error: 'unknown session' }, 404);
    const result = await catchUp(s, ask, facts(id));
    if (!result) return c.json({ error: 'Nothing to go on: no conversation in the last week, or no answer from Claude.' }, 422);
    return c.json({ catchUp: result } satisfies CatchUpWire);
  });
}
