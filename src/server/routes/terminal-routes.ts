import type { Hono } from 'hono';
import type { TerminalElsewhere, TerminalTicketWire } from '../../core/api-types.js';
import { cleanPerfReport, perfLine } from '../../core/pty/terminal-perf.js';

/**
 * `POST /api/terminals/:id/ticket {force?}`: the Terminal tab asks where to connect. work web does what its relay did
 * before connecting — refuses a Claude running in another terminal (unless `force`), starts the agent in the PTY host
 * — and then hands the page the host's address with a one-time ticket for the page's origin, so keystrokes and echoes
 * go straight between the page and the host, never through work web's event loop (reported: typing lagged in the app
 * while `work attach` on the same host was smooth). A host from before tickets, or a request with no page origin:
 * `fallback`, and the tab goes through the relay as before. A POST: it may start an agent (§1.5).
 */
export interface TerminalRoutesOptions {
  elsewhere: (id: string) => TerminalElsewhere | null | Promise<TerminalElsewhere | null>;
  /** Start (or find) the terminal in the PTY host; null for an unknown one. Throws why it can't. */
  ensure: (id: string) => Promise<string | null>;
  /** The host's address for this terminal with a ticket for this origin; null when it can't give one. */
  ticket: (id: string, origin: string) => Promise<string | null>;
  /** Where `POST /api/terminal-perf` writes its line (work web: the debug log). */
  log: (line: string) => void;
}

export function mountTerminalRoutes(app: Hono, opts: TerminalRoutesOptions): void {
  // The "is this session known?" gate the client may hit first (the WebSocket upgrade itself is the http server's).
  app.get('/api/sessions/:id/terminal/health', (c) => {
    return c.json({ ok: true, sessionId: c.req.param('id') });
  });

  app.post('/api/terminals/:id/ticket', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { force?: unknown };
    const origin = c.req.header('origin');
    // Not a page (a script, a test): nothing to tie a ticket to.
    if (!origin) return c.json({ fallback: true } satisfies TerminalTicketWire);
    if (body.force !== true) {
      const elsewhere = await opts.elsewhere(id);
      if (elsewhere) return c.json({ elsewhere } satisfies TerminalTicketWire);
    }
    let running: string | null;
    try {
      running = await opts.ensure(id);
    } catch (err) {
      return c.json({ error: (err as Error).message } satisfies TerminalTicketWire, 409);
    }
    if (!running) return c.json({ error: 'unknown session' } satisfies TerminalTicketWire, 404);
    const url = await opts.ticket(id, origin).catch(() => null);
    return c.json((url ? { url } : { fallback: true }) satisfies TerminalTicketWire);
  });

  // What a Terminal tab measured — keystrokes and the window's freezes — into the debug log, where it can be read
  // (a tooltip can't be copied). A POST: it writes.
  app.post('/api/terminal-perf', async (c) => {
    const report = cleanPerfReport(await c.req.json().catch(() => null));
    if (!report) return c.json({ error: 'not a terminal-perf report' }, 400);
    opts.log(perfLine(report));
    return c.body(null, 204);
  });
}
