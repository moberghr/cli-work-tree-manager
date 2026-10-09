import type { Hono } from 'hono';
import type { TimeDaysWire, TimeDayWire, TimeGraphWire, TimePostWire } from '../../core/api-types.js';
import {
  finishDeviceLogin,
  graphAccount,
  graphApp,
  graphProblem,
  signOutGraph,
  startDeviceLogin,
  type DeviceLogin,
  type GraphApp,
} from '../../core/time/graph.js';
import { buildDay, dayWire, daysWire, type TimeDeps } from '../../core/time/time-days.js';
import { addDays, isDay, localDay, parseEntries } from '../../core/time/time-view.js';
import { updateDay } from '../../core/time/time-store.js';
import { tempoClient, tempoSetup, type TempoApi } from '../../core/time/tempo.js';
import { postStoredDay } from '../../core/time/time-actions.js';
import { loadConfig } from '../../core/platform/config.js';
import type { TimeEntry } from '../../core/time/allocate.js';

/**
 * The Time tab:
 *
 *   GET  /api/time?from=&to=      — the days (two weeks back by default)
 *   GET  /api/time/:day           — a day: evidence, suggestion, what will be posted
 *   PUT  /api/time/:day           — your rows ({entries}, null = back to the suggestion), a day off ({dayOff})
 *   POST /api/time/:day/rebuild   — gather its evidence again
 *   POST /api/time/:day/post      — make Tempo's day what the tab shows (tempo.ts: what's there read first)
 *   GET  /api/time/graph          — Outlook and Teams: signed in, a sign-in under way (its code), or why not
 *   POST /api/time/graph/connect  — start the device-code sign-in; it finishes in the background (`time-graph-changed`)
 *   POST /api/time/graph/disconnect
 *
 * Each change broadcasts `time-changed`.
 */

/** The most days one list asks for (a quarter): a range from year 1 would hold up every request while it's worked out. */
export const MAX_RANGE_DAYS = 92;

/** How to reach Tempo now, or why not: the token from the environment, never sent to the browser. */
export type TempoAccess = () => { api: TempoApi; accountId: string } | { why: string };

const realTempo: TempoAccess = () => {
  const s = tempoSetup(loadConfig()?.time?.tempo, process.env);
  return s.ready ? { api: tempoClient(s.token), accountId: s.accountId } : { why: s.why };
};

/** Microsoft Graph sign-in (graph.ts), passed in for tests. */
export interface GraphAccess {
  app: () => GraphApp | { why: string };
  start: (app: GraphApp) => Promise<DeviceLogin>;
  /** Waits for the code; `cancelled` says when to give up and keep nothing (disconnected, or connecting again). */
  finish: (app: GraphApp, login: DeviceLogin, cancelled: () => boolean) => Promise<string>;
  account: () => string | null;
  /** Signed in, but it stopped working (a refused refresh, another app): why. */
  problem: () => string | null;
  signOut: () => void;
}

const realGraph: GraphAccess = {
  app: () => graphApp(loadConfig()?.time?.graph, process.env),
  start: (a) => startDeviceLogin(a),
  finish: (a, l, cancelled) => finishDeviceLogin(a, l, { cancelled }),
  account: graphAccount,
  problem: () => graphProblem(graphApp(loadConfig()?.time?.graph, process.env)),
  signOut: signOutGraph,
};

export function mountTimeRoutes(
  app: Hono,
  opts: {
    deps: TimeDeps;
    broadcast: (event: string, data: unknown) => void;
    tempo?: TempoAccess;
    graph?: GraphAccess;
    /** Signed in or out of Outlook and Teams: the days' evidence changes (work web rebuilds today). */
    onGraphChanged?: () => void;
  },
): void {
  const graph = opts.graph ?? realGraph;
  let login: DeviceLogin | null = null;
  let loginError: string | null = null;
  const graphWire = (): TimeGraphWire => {
    const a = graph.app();
    return {
      ready: !('why' in a),
      why: 'why' in a ? a.why : null,
      account: graph.account(),
      problem: graph.problem(),
      login: login
        ? { userCode: login.userCode, verificationUri: login.verificationUri, expiresAt: new Date(login.expiresAt).toISOString() }
        : null,
      error: loginError,
    };
  };
  const graphChanged = () => {
    opts.broadcast('time-graph-changed', {});
    opts.onGraphChanged?.();
  };

  app.get('/api/time/graph', (c) => c.json<TimeGraphWire>(graphWire()));
  app.post('/api/time/graph/connect', async (c) => {
    const a = graph.app();
    if ('why' in a) return c.json({ error: a.why }, 409);
    let l: DeviceLogin;
    try {
      l = await graph.start(a);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
    login = l;
    loginError = null;
    // Finishes when the code is entered (or it expires): then today again, with meetings and chats.
    void graph
      .finish(a, l, () => login !== l)
      .then(
        () => {
          if (login === l) login = null;
          graphChanged();
        },
        (err: Error) => {
          if (login !== l) return; // given up on: disconnected, or connecting again
          login = null;
          loginError = err.message;
          graphChanged();
        },
      );
    return c.json<TimeGraphWire>(graphWire());
  });
  app.post('/api/time/graph/disconnect', (c) => {
    graph.signOut();
    login = null;
    loginError = null;
    graphChanged();
    return c.json<TimeGraphWire>(graphWire());
  });

  const changed = (day: string) => opts.broadcast('time-changed', { day });
  const tempo = opts.tempo ?? realTempo;
  const withPosting = (w: TimeDayWire): TimeDayWire => {
    const t = tempo();
    return { ...w, posting: 'why' in t ? { ready: false, why: t.why } : { ready: true, why: null } };
  };

  app.get('/api/time', (c) => {
    const to = c.req.query('to') ?? localDay();
    const from = c.req.query('from') ?? addDays(to, -13);
    if (!isDay(from) || !isDay(to) || from > to) return c.json({ error: 'from and to: real days (YYYY-MM-DD), from ≤ to' }, 400);
    if (addDays(from, MAX_RANGE_DAYS - 1) < to) return c.json({ error: `at most ${MAX_RANGE_DAYS} days at once` }, 400);
    return c.json<TimeDaysWire>(daysWire(from, to, opts.deps.settings()));
  });

  app.get('/api/time/:day', (c) => {
    const day = c.req.param('day');
    if (!isDay(day)) return c.json({ error: 'day: a real day, YYYY-MM-DD' }, 400);
    return c.json<TimeDayWire>(withPosting(dayWire(day, opts.deps.settings())));
  });

  app.post('/api/time/:day/post', async (c) => {
    const day = c.req.param('day');
    if (!isDay(day)) return c.json({ error: 'day: a real day, YYYY-MM-DD' }, 400);
    const t = tempo();
    if ('why' in t) return c.json({ error: t.why }, 409);
    let counts;
    try {
      counts = await postStoredDay(day, opts.deps, t);
    } catch (err) {
      // Tempo's day couldn't be read: nothing was changed.
      return c.json({ error: (err as Error).message }, 502);
    }
    changed(day);
    return c.json<TimePostWire>({ ...counts, day: withPosting(dayWire(day, opts.deps.settings())) });
  });

  app.put('/api/time/:day', async (c) => {
    const day = c.req.param('day');
    if (!isDay(day)) return c.json({ error: 'day: a real day, YYYY-MM-DD' }, 400);
    const body = (await c.req.json().catch(() => null)) as { entries?: unknown; dayOff?: unknown } | null;
    if (!body || (body.entries === undefined && body.dayOff === undefined)) return c.json({ error: 'entries or dayOff' }, 400);
    const settings = opts.deps.settings();
    let edited: TimeEntry[] | null | undefined;
    if (body.entries !== undefined) {
      edited = body.entries === null ? null : parseEntries(body.entries, settings.stepHours);
      if (edited === null && body.entries !== null)
        return c.json({ error: `entries: issue keys, hours in steps of ${settings.stepHours}, each key once` }, 400);
    }
    if (body.dayOff !== undefined && typeof body.dayOff !== 'boolean') return c.json({ error: 'dayOff: boolean' }, 400);
    updateDay(day, { ...(edited !== undefined ? { edited } : {}), ...(typeof body.dayOff === 'boolean' ? { dayOff: body.dayOff } : {}) });
    changed(day);
    return c.json<TimeDayWire>(withPosting(dayWire(day, settings)));
  });

  app.post('/api/time/:day/rebuild', async (c) => {
    const day = c.req.param('day');
    if (!isDay(day)) return c.json({ error: 'day: a real day, YYYY-MM-DD' }, 400);
    // One build of a day at a time (buildDay): a Gather while the keeper builds gets that build.
    try {
      await buildDay(day, opts.deps);
    } catch (err) {
      return c.json({ error: `Couldn't gather the day: ${(err as Error).message}` }, 500);
    }
    changed(day);
    return c.json<TimeDayWire>(withPosting(dayWire(day, opts.deps.settings())));
  });
}
