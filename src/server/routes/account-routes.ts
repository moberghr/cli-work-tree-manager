import type { Context, Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { AccountAdminError, agentFor, type AgentAccounts } from '../../core/agents/index.js';
import { DEFAULT_ACCOUNT, loadConfig } from '../../core/platform/config.js';
import type { AccountSwitcher } from '../../core/sessions/account-switch.js';
import { switchAllSessions, switchAllSummary } from '../../core/sessions/account-switch-all.js';
import { sessionIdFor } from '../../core/sessions/session-id.js';
import { accountOverview, addAgentAccount, setDefaultAgentAccount, type AccountLogins } from '../../core/sessions/account-admin.js';
import { removeAgentAccount } from '../../core/sessions/account-users.js';
import { loadHistory } from '../../core/sessions/history.js';
import type { WorktreeSession } from '../../core/sessions/session-types.js';
import type { UsageAccount } from '../../core/usage/usage.js';
import type {
  AccountAddWire,
  AccountLoginWire,
  AccountRefusalWire,
  AccountSetupWire,
  AccountsWire,
  AccountSwitchAllWire,
  AccountSwitchWire,
  AccountWire,
} from '../../core/api-types.js';

/**
 * Accounts (Claude Code logins, agents/claude/accounts.ts), managed from the dashboard's Accounts page with the same core
 * as `work account` (account-admin.ts), and moving a session between them (account-switch.ts):
 *
 *   GET  /api/accounts                   → AccountsWire (a read: nothing started or changed)
 *   POST /api/accounts {name, folder?}   → AccountAddWire (400: a name or folder that can't be one)
 *   POST /api/accounts/:name/default     → new sessions use it
 *   DELETE /api/accounts/:name[?force=1] → forget it (its folder stays); 409 while sessions are on it (archived: force)
 *   POST /api/accounts/:name/login       → AccountLoginWire: its login terminal in the PTY host
 *   DELETE /api/accounts/:name/login     → stop it (work's skills then go into a new account's folder, in the background)
 *   GET  /api/accounts/:name/setup?from=x → AccountSetupWire: what copying x's setup to it would do (a read)
 *   POST /api/accounts/:name/setup {from}  → AccountSetupWire: it done (instructions, settings, tool servers, plugins; never a login)
 *   POST /api/accounts/:name/sessions {from?} → AccountSwitchAllWire: every session (or those on `from`) moved to it
 *   POST /api/sessions/:id/account  {to} → AccountSwitchWire: switched / queued (its turn first) / recorded (not running)
 *   DELETE /api/sessions/:id/account     → drop the switch waiting for its turn (409: none waits, or it is being done now)
 *
 * Every change broadcasts `accounts-changed`.
 */
export function mountAccountRoutes(
  app: Hono,
  opts: {
    switcher: AccountSwitcher;
    broadcast: (event: string, data: unknown) => void;
    /** Lists, but changes nothing, and says why (the dev server shares the real PTY host and acts on nothing). */
    lookOnly?: string;
    /** The login terminals (account-admin.ts `createAccountLogins`); absent: none can be opened here. */
    logins?: AccountLogins;
    /** The agent's accounts (default: the configured agent's). */
    accounts?: () => AgentAccounts | undefined;
    /** Its last usage readings, one per account (default: the configured agent's). */
    readings?: () => UsageAccount[];
    /** Every session, for who is on which account (default: the history). */
    sessions?: () => readonly WorktreeSession[];
  },
): void {
  const accountsNow = opts.accounts ?? (() => agentFor(loadConfig()).accounts);
  const readings = opts.readings ?? (() => agentFor(loadConfig()).usage?.read() ?? []);
  const sessions = opts.sessions ?? loadHistory;
  const changed = () => opts.broadcast('accounts-changed', { ts: Date.now() });

  /** Why nothing may be changed here, or null. */
  const cantManage = (accounts: AgentAccounts | undefined): string | null =>
    opts.lookOnly ?? (accounts?.admin ? null : 'its accounts are not managed by work');

  /** A refusal as the page reads it: a removal's sessions with whether they can be forced past. */
  const refused = (c: Context, e: unknown) => {
    if (e instanceof AccountAdminError) {
      const body: AccountRefusalWire = {
        error: e.message,
        ...(e.sessions.length ? { sessions: e.sessions } : {}),
        ...(e.kind ? { kind: e.kind } : {}),
      };
      return c.json(body, e.sessions.length ? 409 : 400);
    }
    return c.json({ error: e instanceof Error ? e.message : String(e) } satisfies AccountRefusalWire, 500);
  };

  app.get('/api/accounts', (c) => {
    const accounts = accountsNow();
    const rows: AccountWire[] = accounts
      ? accountOverview(accounts, readings(), sessions()).map((a) => ({
          name: a.name,
          dir: a.dir,
          isDefault: a.isDefault,
          loggedIn: a.loggedIn,
          liveSessions: a.live,
          archivedSessions: a.archived,
          usage: a.usage,
        }))
      : [];
    const why = cantManage(accounts) ?? (opts.logins ? null : 'login terminals are not available here');
    return c.json({
      accounts: rows,
      default: accounts?.defaultName() ?? DEFAULT_ACCOUNT,
      canManage: why === null,
      ...(why ? { manageNote: why } : {}),
    } satisfies AccountsWire);
  });

  app.post(
    '/api/accounts',
    zValidator('json', z.object({ name: z.string().min(1).max(64), folder: z.string().max(1024).optional() })),
    async (c) => {
      const accounts = accountsNow();
      const no = cantManage(accounts);
      if (no) return c.json({ error: no } satisfies AccountRefusalWire, 409);
      const { name, folder } = c.req.valid('json');
      try {
        const dir = await addAgentAccount(accounts, name, folder);
        changed();
        return c.json({ ok: true, name, dir } satisfies AccountAddWire);
      } catch (e) {
        return refused(c, e);
      }
    },
  );

  app.post('/api/accounts/:name/default', async (c) => {
    const accounts = accountsNow();
    const no = cantManage(accounts);
    if (no) return c.json({ error: no } satisfies AccountRefusalWire, 409);
    try {
      await setDefaultAgentAccount(accounts, c.req.param('name'));
      changed();
      return c.json({ ok: true });
    } catch (e) {
      return refused(c, e);
    }
  });

  app.delete('/api/accounts/:name', async (c) => {
    const accounts = accountsNow();
    const no = cantManage(accounts);
    if (no || !accounts) return c.json({ error: no ?? 'no accounts' } satisfies AccountRefusalWire, 409);
    const name = c.req.param('name');
    try {
      await removeAgentAccount(accounts, name, { force: c.req.query('force') === '1', sessions });
    } catch (e) {
      return refused(c, e);
    }
    // A login terminal still open on it would go on in a folder work no longer knows: stopped (no skills: it's gone).
    await opts.logins?.stop(name).catch(() => undefined);
    changed();
    return c.json({ ok: true });
  });

  app.post('/api/accounts/:name/login', async (c) => {
    const accounts = accountsNow();
    const no = cantManage(accounts) ?? (opts.logins ? null : 'login terminals are not available here');
    if (no || !opts.logins) return c.json({ error: no ?? '' } satisfies AccountRefusalWire, 409);
    try {
      const id = await opts.logins.start(c.req.param('name'));
      return c.json({ ok: true, id } satisfies AccountLoginWire);
    } catch (e) {
      if (e instanceof AccountAdminError) return refused(c, e);
      return c.json({ error: e instanceof Error ? e.message : String(e) } satisfies AccountRefusalWire, 502);
    }
  });

  app.delete('/api/accounts/:name/login', async (c) => {
    if (opts.lookOnly) return c.json({ error: opts.lookOnly } satisfies AccountRefusalWire, 409);
    if (!opts.logins) return c.json({ error: 'login terminals are not available here' } satisfies AccountRefusalWire, 409);
    const name = c.req.param('name');
    try {
      const { skills } = await opts.logins.stop(name);
      // The login may have changed what the page shows (logged in now); and again once the skills are in.
      changed();
      void skills?.then(changed);
      return c.json({ ok: true, installingSkills: skills !== null });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) } satisfies AccountRefusalWire, 502);
    }
  });

  /** "3 things to copy from default to admin" / "admin already has default's setup". */
  const planSummary = (n: number, from: string, to: string) =>
    n === 0 ? `${to} already has ${from}'s setup: nothing to copy.` : `${n} thing${n === 1 ? '' : 's'} to copy from ${from} to ${to}.`;

  app.get('/api/accounts/:name/setup', (c) => {
    const accounts = accountsNow();
    const from = c.req.query('from') ?? '';
    const to = c.req.param('name');
    if (!accounts?.admin?.setupPlan) return c.json({ error: 'its accounts have no setup to copy' } satisfies AccountRefusalWire, 409);
    if (!from) return c.json({ error: 'from is required' } satisfies AccountRefusalWire, 400);
    try {
      const items = accounts.admin.setupPlan(from, to);
      return c.json({ from, to, summary: planSummary(items.length, from, to), items } satisfies AccountSetupWire);
    } catch (e) {
      return refused(c, e);
    }
  });

  app.post('/api/accounts/:name/setup', zValidator('json', z.object({ from: z.string().min(1).max(64) })), async (c) => {
    const accounts = accountsNow();
    const no = cantManage(accounts);
    if (no) return c.json({ error: no } satisfies AccountRefusalWire, 409);
    if (!accounts?.admin?.copySetup) return c.json({ error: 'its accounts have no setup to copy' } satisfies AccountRefusalWire, 409);
    const { from } = c.req.valid('json');
    const to = c.req.param('name');
    try {
      const items = await accounts.admin.copySetup(from, to);
      const ok = items.filter((i) => i.ok).length;
      changed();
      return c.json({
        from,
        to,
        summary:
          items.length === 0
            ? planSummary(0, from, to)
            : `Copied ${ok} of ${items.length} thing${items.length === 1 ? '' : 's'} from ${from} to ${to}${ok < items.length ? `; ${items.length - ok} failed` : ''}. Restart a session's Claude for it to see them.`,
        items,
      } satisfies AccountSetupWire);
    } catch (e) {
      return refused(c, e);
    }
  });

  app.post('/api/accounts/:name/sessions', zValidator('json', z.object({ from: z.string().min(1).max(64).optional() })), async (c) => {
    if (opts.lookOnly) return c.json({ error: opts.lookOnly } satisfies AccountRefusalWire, 409);
    const to = c.req.param('name');
    const { from } = c.req.valid('json');
    const rows = await switchAllSessions(
      {
        sessions,
        accountOf: (s) => s.account ?? DEFAULT_ACCOUNT,
        idOf: sessionIdFor,
        switchAccount: (id, name) => opts.switcher.switchAccount(id, name),
      },
      to,
      from,
    );
    // An account nobody knows is refused for every session: said once, as one refusal.
    if (rows.length > 0 && rows.every((r) => r.error) && new Set(rows.map((r) => r.error)).size === 1)
      return c.json({ error: rows[0].error ?? '' } satisfies AccountRefusalWire, 409);
    opts.broadcast('sessions-changed', { ts: Date.now() });
    changed();
    return c.json({ ok: true, summary: switchAllSummary(rows, to), sessions: rows } satisfies AccountSwitchAllWire);
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
