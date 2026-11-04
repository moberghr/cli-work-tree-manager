import type { AccountAddWire, AccountRefusalWire, AccountsWire, AccountSwitchWire, AccountWire } from '../../core/api-types.js';
import { accountNameProblem, DEFAULT_ACCOUNT_NAME } from '../../core/sessions/account-names.js';
import { accountLoginId } from '../../core/pty/account-login-id.js';
import { switchRefusal } from '../../core/sessions/account-switch-rules.js';
import { demoUsage } from './demo-usage.js';

/** The demo's Claude accounts at start: the default, a second one logged in (a switch just records it), and one nobody logged in to. */
export const DEMO_ACCOUNTS: AccountsWire = {
  accounts: [
    { name: 'default', dir: '~/.claude', isDefault: true, loggedIn: true },
    { name: 'work', dir: '~/.claude-work', isDefault: false, loggedIn: true },
    { name: 'spare', dir: '~/.claude-spare', isDefault: false, loggedIn: false },
  ],
  default: 'default',
};

/** A session as the demo's accounts see it: its account, whether it is archived, and how it is named. */
export interface DemoAccountUser {
  account?: string;
  archived: boolean;
  label: string;
}

type Refused = { ok: false; status: 400 | 409; body: AccountRefusalWire };

/**
 * The demo's accounts, changed by the Accounts page as the real ones are (the same name rules, account-names.ts; a
 * removal refused while sessions are on it, an archived one forced past), and a pretend login terminal: it shows Claude
 * Code's welcome, and `/login` marks the account logged in.
 */
export class DemoAccounts {
  private rows: Array<Pick<AccountWire, 'name' | 'dir' | 'loggedIn'>> = DEMO_ACCOUNTS.accounts.map(({ name, dir, loggedIn }) => ({
    name,
    dir,
    loggedIn,
  }));
  private chosen = DEMO_ACCOUNTS.default;

  has(name: string): boolean {
    return this.rows.some((a) => a.name === name);
  }

  /** The plain list (what a switch's rules read). */
  list(): AccountWire[] {
    return this.rows.map((a) => ({ ...a, isDefault: a.name === this.chosen }));
  }

  /** GET /api/accounts. */
  wire(users: readonly DemoAccountUser[], now = Date.now()): AccountsWire {
    const readings = demoUsage(now).agents[0]?.accounts ?? [];
    const on = (name: string, archived: boolean) =>
      users.filter((u) => (u.account ?? DEFAULT_ACCOUNT_NAME) === name && u.archived === archived).map((u) => u.label);
    return {
      accounts: this.list().map((a) => ({
        ...a,
        liveSessions: on(a.name, false),
        archivedSessions: on(a.name, true),
        usage: readings.find((r) => r.account === a.name) ?? null,
      })),
      default: this.chosen,
      canManage: true,
    };
  }

  add(name: string, folder?: string): { ok: true; body: AccountAddWire } | Refused {
    const problem = accountNameProblem(
      name,
      this.rows.map((a) => a.name),
    );
    if (problem) return { ok: false, status: 400, body: { error: problem } };
    const dir = folder?.trim() || `~/.claude-${name}`;
    if (!/^(~[\\/]|\/|[A-Za-z]:[\\/])/.test(dir)) return { ok: false, status: 400, body: { error: `${dir} is not an absolute folder` } };
    if (this.rows.some((a) => a.dir === dir))
      return { ok: false, status: 400, body: { error: `${dir} is already another account's folder` } };
    this.rows.push({ name, dir, loggedIn: false });
    return { ok: true, body: { ok: true, name, dir } };
  }

  setDefault(name: string): { ok: true } | Refused {
    if (!this.has(name)) return { ok: false, status: 400, body: { error: `no account “${name}”` } };
    this.chosen = name;
    return { ok: true };
  }

  remove(name: string, force: boolean, users: readonly DemoAccountUser[]): { ok: true } | Refused {
    if (name === DEFAULT_ACCOUNT_NAME)
      return { ok: false, status: 400, body: { error: 'the default account (~/.claude) can not be removed' } };
    if (!this.has(name)) return { ok: false, status: 400, body: { error: `no account “${name}”` } };
    const on = users.filter((u) => u.account === name);
    const live = on.filter((u) => !u.archived).map((u) => u.label);
    const archived = on.filter((u) => u.archived).map((u) => u.label);
    const n = (k: number, what: string) => `${k} ${what} session${k === 1 ? '' : 's'}`;
    if (live.length)
      return { ok: false, status: 409, body: { error: `${n(live.length, 'live')} on ${name}`, sessions: live, kind: 'live' } };
    if (archived.length && !force)
      return {
        ok: false,
        status: 409,
        body: {
          error: `${n(archived.length, 'archived')} on ${name} (a Restore would start it on the default account instead)`,
          sessions: archived,
          kind: 'archived',
        },
      };
    this.rows = this.rows.filter((a) => a.name !== name);
    if (this.chosen === name) this.chosen = DEFAULT_ACCOUNT_NAME;
    return { ok: true };
  }

  /** The pretend login terminal's first screen. */
  loginScreen(name: string): string {
    return [
      '╭───────────────────────────────────────────────╮',
      `│ ✻ Claude Code  ·  account ${name.padEnd(20)}│`,
      '╰───────────────────────────────────────────────╯',
      '',
      '  (demo) Type /login to log in to this account, then close the panel.',
      '',
      '> ',
    ].join('\r\n');
  }

  /** A line typed into it: what it prints back, and whether the account changed (logged in now). */
  loginInput(name: string, line: string): { output: string; changed: boolean } {
    const text = line.trim();
    const row = this.rows.find((a) => a.name === name);
    if (text === '/login' && row) {
      row.loggedIn = true;
      return { output: `\r\n● (demo) Logged in to ${name} as you@example.com.\r\n> `, changed: true };
    }
    return { output: `\r\n● (demo) Type /login to log in.\r\n> `, changed: false };
  }

  /** POST /api/accounts/:name/login. */
  startLogin(name: string): { ok: true; id: string } | Refused {
    if (!this.has(name)) return { ok: false, status: 400, body: { error: `no account “${name}”` } };
    return { ok: true, id: accountLoginId(name) };
  }
}

/** What a switch of a demo session answers, by the real one's rules (account-switch-rules.ts) applied to a made-up world. */
export function demoSwitch(
  session: { account?: string; archived: boolean },
  to: string,
  list: AccountWire[] = DEMO_ACCOUNTS.accounts,
): { ok: true; body: AccountSwitchWire } | { ok: false; status: 400 | 409; error: string } {
  const refused = switchRefusal(to, {
    archived: session.archived,
    accounts: { list, current: session.account ?? 'default' },
    pendingTo: null,
    // The demo's Claudes are all "in the host": none runs in a terminal outside it.
    inHost: true,
    runningOutside: false,
  });
  if (refused) return { ok: false, ...refused };
  return { ok: true, body: { ok: true, outcome: 'recorded', moved: 0 } };
}
