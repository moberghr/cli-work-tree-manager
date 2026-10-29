import type { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { agentFor } from '../../core/agents/index.js';
import { DEFAULT_ACCOUNT, loadConfig } from '../../core/platform/config.js';
import type { AccountSwitcher } from '../../core/sessions/account-switch.js';
import type { AccountsWire, AccountSwitchWire } from '../../core/api-types.js';

/**
 * Accounts (Claude Code logins, agents/claude/accounts.ts) and moving a session between them (account-switch.ts):
 *
 *   GET  /api/accounts              → AccountsWire (a read: nothing started or changed)
 *   POST /api/sessions/:id/account  {to} → AccountSwitchWire: switched / queued (its turn first) / recorded (not running)
 *   DELETE /api/sessions/:id/account     → drop the switch waiting for its turn (409: none waits, or it is being done now)
 */
export function mountAccountRoutes(
  app: Hono,
  opts: {
    switcher: AccountSwitcher;
    broadcast: (event: string, data: unknown) => void;
    /** Lists, but switches nothing, and says why (the dev server shares the real PTY host and acts on nothing). */
    lookOnly?: string;
  },
): void {
  app.get('/api/accounts', (c) => {
    const accounts = agentFor(loadConfig()).accounts;
    const list = accounts?.list() ?? [];
    return c.json({
      accounts: list.map((a) => ({ name: a.name, dir: a.dir, isDefault: a.isDefault, loggedIn: a.loggedIn })),
      default: accounts?.defaultName() ?? DEFAULT_ACCOUNT,
    } satisfies AccountsWire);
  });

  app.post('/api/sessions/:id/account', zValidator('json', z.object({ to: z.string().min(1).max(64) })), async (c) => {
    if (opts.lookOnly) return c.json({ error: opts.lookOnly }, 409);
    const r = await opts.switcher.switchAccount(c.req.param('id'), c.req.valid('json').to).catch((err: Error) => ({
      ok: false as const,
      status: 502 as const,
      error: err.message,
    }));
    if (!r.ok) return c.json({ error: r.error }, r.status);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true, outcome: r.outcome, ...(r.moved !== undefined ? { moved: r.moved } : {}) } satisfies AccountSwitchWire);
  });

  app.delete('/api/sessions/:id/account', (c) => {
    if (opts.lookOnly) return c.json({ error: opts.lookOnly }, 409);
    const r = opts.switcher.cancel(c.req.param('id'));
    if (r === 'running') return c.json({ error: 'the switch is being done right now' }, 409);
    if (r === 'none') return c.json({ error: 'no switch is waiting for its turn' }, 409);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    return c.json({ ok: true });
  });
}
