import type { AccountsWire, AccountSwitchWire } from '../../core/api-types.js';
import { switchRefusal } from '../../core/sessions/account-switch-rules.js';

/** The demo's Claude accounts: the default, a second one logged in (a switch just records it), and one nobody logged in to. */
export const DEMO_ACCOUNTS: AccountsWire = {
  accounts: [
    { name: 'default', dir: '~/.claude', isDefault: true, loggedIn: true },
    { name: 'work', dir: '~/.claude-work', isDefault: false, loggedIn: true },
    { name: 'spare', dir: '~/.claude-spare', isDefault: false, loggedIn: false },
  ],
  default: 'default',
};

/** An account name the demo knows (a new session may pick one in New worktree's More options). */
export const isDemoAccount = (name: string): boolean => DEMO_ACCOUNTS.accounts.some((a) => a.name === name);

/** What a switch of a demo session answers, by the real one's rules (account-switch-rules.ts) applied to a made-up world. */
export function demoSwitch(
  session: { account?: string; archived: boolean },
  to: string,
): { ok: true; body: AccountSwitchWire } | { ok: false; status: 400 | 409; error: string } {
  const refused = switchRefusal(to, {
    archived: session.archived,
    accounts: { list: DEMO_ACCOUNTS.accounts, current: session.account ?? 'default' },
    pendingTo: null,
    // The demo's Claudes are all "in the host": none runs in a terminal outside it.
    inHost: true,
    runningOutside: false,
  });
  if (refused) return { ok: false, ...refused };
  return { ok: true, body: { ok: true, outcome: 'recorded', moved: 0 } };
}
