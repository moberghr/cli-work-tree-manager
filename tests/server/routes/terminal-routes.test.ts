import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mountTerminalRoutes, type TerminalRoutesOptions } from '../../../src/server/routes/terminal-routes.js';
import type { TerminalElsewhere } from '../../../src/core/api-types.js';

/** `POST /api/terminals/:id/ticket`: where the Terminal tab connects — straight to the PTY host, or the relay. */

const page = 'http://127.0.0.1:54989';
const elsewhere: TerminalElsewhere = { type: 'elsewhere', lastActivity: 1, state: 'idle' } as TerminalElsewhere;

function setup(over: Partial<TerminalRoutesOptions> = {}) {
  const opts = {
    elsewhere: vi.fn(async () => null),
    ensure: vi.fn(async () => 'ws://127.0.0.1:1/ptys/s1/attach?token=t'),
    ticket: vi.fn(async (id: string) => `ws://127.0.0.1:1/ptys/${id}/attach?ticket=abc`),
    ...over,
  };
  const app = new Hono();
  mountTerminalRoutes(app, opts);
  const ask = (body: unknown = {}, origin: string | null = page) =>
    app.request('/api/terminals/s1/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });
  return { opts, ask };
}

describe('the terminal ticket route', () => {
  it("starts the agent, then answers the host's address with a ticket for the page's origin", async () => {
    const { opts, ask } = setup();
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'ws://127.0.0.1:1/ptys/s1/attach?ticket=abc' });
    expect(opts.ensure).toHaveBeenCalledWith('s1');
    expect(opts.ticket).toHaveBeenCalledWith('s1', page);
  });

  it('a Claude in another terminal: said, nothing started — unless forced', async () => {
    const { opts, ask } = setup({ elsewhere: vi.fn(async () => elsewhere) });
    expect(await (await ask()).json()).toEqual({ elsewhere });
    expect(opts.ensure).not.toHaveBeenCalled();
    expect(await (await ask({ force: true })).json()).toMatchObject({ url: expect.any(String) });
  });

  it("a start that's refused says why; an unknown session is 404", async () => {
    expect(await (await setup({ ensure: vi.fn(async () => Promise.reject(new Error('archived'))) }).ask()).json()).toEqual({
      error: 'archived',
    });
    const unknown = await setup({ ensure: vi.fn(async () => null) }).ask();
    expect(unknown.status).toBe(404);
  });

  it('the relay when the host gives no ticket (from before tickets), or the request comes from no page', async () => {
    expect(await (await setup({ ticket: vi.fn(async () => null) }).ask()).json()).toEqual({ fallback: true });
    const { opts, ask } = setup();
    expect(await (await ask({}, null)).json()).toEqual({ fallback: true });
    expect(opts.ensure).not.toHaveBeenCalled();
  });

  it('the gate route is still there', async () => {
    const app = new Hono();
    mountTerminalRoutes(app, setup().opts);
    expect(await (await app.request('/api/sessions/s1/terminal/health')).json()).toEqual({ ok: true, sessionId: 's1' });
  });
});
