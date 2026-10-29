import path from 'node:path';
import { agentOf, liveAgents } from '../agents/index.js';
import { isArchiving } from '../archive/archiving.js';
import { accountSwitchRefusal, peekPty, ptyPid, ptyPids, haltPty, resumePtyOnAccount } from '../pty/pty-pool.js';
import type { AccountSwitchDeps } from './account-switch.js';
import { loadHistory, setSessionAccount } from './history.js';
import { agentsBySession } from './live-agents.js';
import { findSession } from './web-state.js';

/** The real inputs of createAccountSwitcher (account-switch.ts); work web gives `busy`, the Activity notes and the broadcast. */
export function defaultAccountSwitchDeps(opts: Pick<AccountSwitchDeps, 'busy'> & Partial<AccountSwitchDeps>): AccountSwitchDeps {
  return {
    session: findSession,
    beingArchived: isArchiving,
    accounts: (s) => {
      const accounts = agentOf(s).accounts;
      return accounts ? { list: accounts.list(), current: accounts.current(s) } : null;
    },
    switchFiles: (s, to) => {
      const accounts = agentOf(s).accounts;
      if (!accounts) throw new Error('its agent has no accounts');
      return accounts.switchFiles(s, to);
    },
    record: async (s, to) => {
      if (!(await setSessionAccount(s.target, s.branch, to))) throw new Error('unknown session');
    },
    hostRuns: peekPty,
    // Claude Code's process files say one runs for it that isn't the host's (terminal-ws.ts, session-control-routes.ts).
    runningOutside: (id) => {
      const hostPids = ptyPids();
      return (agentsBySession(liveAgents(), loadHistory()).get(id) ?? []).some((c) => !hostPids.has(c.pid));
    },
    othersRunningIn: (s, id) => {
      const folders = agentOf(s).accounts?.folders(s) ?? [];
      if (!folders.length) return null;
      const own = ptyPid(id);
      const key = (p: string) => {
        const r = path.resolve(p).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? r.toLowerCase() : r;
      };
      const wanted = new Map(folders.map((f) => [key(f), f]));
      const other = liveAgents().find((a) => a.pid !== own && wanted.has(key(a.cwd)));
      return other ? (wanted.get(key(other.cwd)) ?? other.cwd) : null;
    },
    hostRefusal: accountSwitchRefusal,
    halt: haltPty,
    resume: resumePtyOnAccount,
    ...opts,
  };
}
