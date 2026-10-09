import type { Hono } from 'hono';
import type { TimeDaysWire, TimeDayWire } from '../../core/api-types.js';
import { buildDay, dayWire, daysWire, type TimeDeps } from '../../core/time/time-days.js';
import { localDay, parseEntries } from '../../core/time/time-view.js';
import { updateDay } from '../../core/time/time-store.js';
import type { TimeEntry } from '../../core/time/allocate.js';

/**
 * The Time tab:
 *
 *   GET  /api/time?from=&to=      — the days (two weeks back by default)
 *   GET  /api/time/:day           — a day: evidence, suggestion, what will be posted
 *   PUT  /api/time/:day           — your rows ({entries}, null = back to the suggestion), a day off ({dayOff})
 *   POST /api/time/:day/rebuild   — gather its evidence again
 *
 * Each change broadcasts `time-changed`.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export function mountTimeRoutes(app: Hono, opts: { deps: TimeDeps; broadcast: (event: string, data: unknown) => void }): void {
  const changed = (day: string) => opts.broadcast('time-changed', { day });

  app.get('/api/time', (c) => {
    const to = c.req.query('to') ?? localDay();
    const from = c.req.query('from') ?? localDay(Date.parse(`${to}T12:00:00`) - 13 * 24 * 3600_000);
    if (!DAY.test(from) || !DAY.test(to) || from > to) return c.json({ error: 'from and to: YYYY-MM-DD, from ≤ to' }, 400);
    return c.json<TimeDaysWire>(daysWire(from, to, opts.deps.settings()));
  });

  app.get('/api/time/:day', (c) => {
    const day = c.req.param('day');
    if (!DAY.test(day)) return c.json({ error: 'day: YYYY-MM-DD' }, 400);
    return c.json<TimeDayWire>(dayWire(day, opts.deps.settings()));
  });

  app.put('/api/time/:day', async (c) => {
    const day = c.req.param('day');
    if (!DAY.test(day)) return c.json({ error: 'day: YYYY-MM-DD' }, 400);
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
    return c.json<TimeDayWire>(dayWire(day, settings));
  });

  app.post('/api/time/:day/rebuild', async (c) => {
    const day = c.req.param('day');
    if (!DAY.test(day)) return c.json({ error: 'day: YYYY-MM-DD' }, 400);
    await buildDay(day, opts.deps);
    changed(day);
    return c.json<TimeDayWire>(dayWire(day, opts.deps.settings()));
  });
}
