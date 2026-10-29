import type { AccountInfo } from '../agents/types.js';
import { createRestarter, type Restarter } from '../pty/agent-restart.js';
import type { WorktreeSession } from './session-types.js';
import type { ActivityLog } from '../platform/activity.js';
import { switchRefusal } from './account-switch-rules.js';

/**
 * Moving a session to another account of its agent (Claude: another login, for when the first one's limit runs out).
 * The policy is here; I/O is passed in (account-routes.ts and web-server.ts give the real one, tests a fake).
 *
 * Refused: an unknown or archived session, an agent with no accounts, an unknown account, one nobody is logged in to, the
 * account it is on, a Claude running in a terminal outside work (a switch can't stop it), one switch already waiting.
 *
 * Not running in the PTY host: its conversations move and the account is recorded — the next start uses it. Running and
 * idle: its Claude is halted in the host (stopped, its terminals kept), the conversations move, the account is recorded, and it
 * is resumed in place on the new account — in that order, so nothing writes into the old folder while it moves. Working, or waiting
 * on you: after its turn — through the agent restarter's queue (agent-restart.ts), so the rule for "not mid-turn" is the
 * restart's own, with a switch as the thing that runs when its turn ends.
 */

export interface AccountSwitchDeps {
  session: (id: string) => WorktreeSession | null;
  /** Being archived right now (its Claude was stopped on purpose, and mustn't be started again). */
  beingArchived: (id: string) => boolean;
  /** Its agent's accounts; null: its agent has none. */
  accounts: (session: WorktreeSession) => { list: AccountInfo[]; current: string } | null;
  /** Move its conversations to `to`'s folders (puts back what it moved when it fails, and throws). */
  switchFiles: (session: WorktreeSession, to: string) => Promise<{ moved: string[] }>;
  /** Record the account on the session, in one transaction. */
  record: (session: WorktreeSession, to: string) => Promise<void>;
  /** Its Claude runs in the PTY host. */
  hostRuns: (id: string) => boolean;
  /** Its Claude runs in a terminal outside work. */
  runningOutside: (id: string) => boolean;
  /** A folder whose conversations the switch would move where another agent (of any account, not this session's own in
   *  the host) runs now — its files would move from under it; null: none. */
  othersRunningIn?: (session: WorktreeSession, id: string) => string | null;
  /** Why the PTY host can't run it on another account (one from before accounts), or null. Asked before anything stops. */
  hostRefusal?: () => Promise<string | null>;
  /** Working, or waiting on you (`turnEnded`: its turn just ended, so what it printed a moment ago isn't work going on). */
  busy: (id: string, opts?: { turnEnded?: boolean }) => boolean;
  /** Stop its Claude in the host and keep its session (terminals attached) until `resume`: the files move only after it is stopped.
   *  `stopped`: an older host stopped it the old way; `gone`: nothing was running. */
  halt: (id: string) => Promise<'halted' | 'stopped' | 'gone'>;
  /** Start it again after `halt`, on the account the session records now (so the old one after a switch that failed): in place
   *  when it was `halted` (its terminals carry on), from a fresh spec when `stopped` (an older host). A string: how it went instead. */
  resume: (id: string, how: 'halted' | 'stopped') => Promise<string | void>;
  /** One line of what a switch decided, for the Activity panel. */
  note?: (id: string, text: string, level: 'action' | 'info' | 'warn') => void;
  changed?: () => void;
  scheduled?: (nextAt: number | null) => void;
  /** A look again a little later (the restarter's own default: setTimeout). */
  later?: (fn: () => void, ms: number) => void;
  /** Drop an agent restart waiting for its turn (agent-restart.ts): the switch restarts it anyway. True when one was waiting. */
  cancelRestart?: (id: string) => boolean;
}

export type SwitchOutcome = 'switched' | 'queued' | 'recorded';

export type SwitchResult =
  { ok: true; outcome: SwitchOutcome; moved?: number } | { ok: false; status: 400 | 404 | 409 | 502; error: string };

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createAccountSwitcher(deps: AccountSwitchDeps) {
  /** Where each waiting (or running) switch goes. */
  const targets = new Map<string, string>();
  /** How many entries each finished switch moved, for the answer. */
  const movedBy = new Map<string, number>();

  const name = (s: WorktreeSession) => `${s.target} ${s.branch}`;

  /** Move the files and record the account; a failed record puts the files back. Returns how many entries moved. */
  const moveAndRecord = async (s: WorktreeSession, to: string, from: string): Promise<number> => {
    const { moved } = await deps.switchFiles(s, to);
    try {
      await deps.record(s, to);
    } catch (err) {
      // The files are in the new account's folders and the session still says the old one: back, or its --continue finds
      // nothing. A move back that fails is said with the error (its message names what is stuck where).
      const back = await deps.switchFiles({ ...s, account: to }, from).then(
        () => '',
        (e2: unknown) => `; and its conversations couldn't all be moved back: ${msg(e2)}`,
      );
      throw new Error(`${msg(err)}${back}`, { cause: err });
    }
    return moved.length;
  };

  /** What the restarter runs for a session (at once when idle, after its turn when not): the move, the record, the restart. */
  const perform = async (id: string): Promise<string | void> => {
    const to = targets.get(id);
    const s = deps.session(id);
    try {
      if (!to || !s) throw new Error('the session is gone');
      if (s.archivedAt || deps.beingArchived(id)) throw new Error('it was archived meanwhile');
      const acc = deps.accounts(s);
      if (!acc) throw new Error('its agent has no accounts');
      const from = acc.current;
      if (from === to) return `already on ${to}`;
      const before = await refusalBeforeStop(s, id);
      if (before) throw new Error(`stays on ${from}: ${before}`);
      // A restart of its agent that waited for this turn too would stop it a second time: the switch's restart does its job.
      if (deps.cancelRestart?.(id)) deps.note?.(id, 'its agent restart that waited for this turn is done by the switch instead', 'info');
      // Stopped first: a running (or just exiting) Claude writes to its transcript, and on Windows holds the file.
      let halted: 'halted' | 'stopped' | null = null;
      if (deps.hostRuns(id)) {
        let h: 'halted' | 'stopped' | 'gone';
        try {
          h = await deps.halt(id);
        } catch (err) {
          throw new Error(`stays on ${from}: couldn't stop its Claude: ${msg(err)}`, { cause: err });
        }
        if (h !== 'gone') halted = h;
      }
      /** Start it again on the account the session records (still the old one until the record is made). */
      const resume = async (): Promise<string | void> => (halted ? deps.resume(id, halted) : undefined);
      let moved: number;
      try {
        moved = await moveAndRecord(s, to, from);
      } catch (err) {
        // Put back (the move rolled itself back, a failed record moved the files back): it goes on running on the account it has.
        const back = await resume().then(
          () => '',
          (e2: unknown) => ` (and couldn't start its Claude again: ${msg(e2)}; opening the session starts it)`,
        );
        throw new Error(`stays on ${from}: ${msg(err)}${back}`, { cause: err });
      }
      movedBy.set(id, moved);
      if (!halted) {
        deps.note?.(id, `moved to the ${to} account (${moved} entries moved; its next start uses it)`, 'action');
        return `moved to the ${to} account`;
      }
      try {
        const how = await resume();
        deps.note?.(id, `moved to the ${to} account: its Claude restarted on it${how ? ` (${how})` : ''}`, 'action');
        return how || `moved to the ${to} account: its Claude restarted on it`;
      } catch (err) {
        // The account is recorded and the files are there: opening the session starts it on the new one.
        const why = `moved to the ${to} account, but its Claude couldn't be restarted: ${msg(err)} (opening the session starts it on ${to})`;
        deps.note?.(id, why, 'warn');
        throw new Error(why, { cause: err });
      }
    } catch (err) {
      if (s && !String(msg(err)).startsWith('moved to')) deps.note?.(id, `couldn't switch: ${msg(err)}`, 'warn');
      throw err;
    } finally {
      targets.delete(id);
    }
  };

  const restarter: Restarter = createRestarter({
    restart: perform,
    busy: deps.busy,
    // A queued switch is never dropped as "stopped meanwhile": perform handles a Claude no longer running (it records the account).
    running: () => true,
    changed: deps.changed,
    scheduled: deps.scheduled,
    later: deps.later,
  });

  /** What stops a switch before anything is stopped or moved: an older PTY host, another Claude in one of its folders. */
  const refusalBeforeStop = async (s: WorktreeSession, id: string): Promise<string | null> => {
    const other = deps.othersRunningIn?.(s, id);
    if (other) return `a Claude outside this session runs in ${other}`;
    return deps.hostRuns(id) ? ((await deps.hostRefusal?.()) ?? null) : null;
  };

  const pending = (id: string) => restarter.queued().includes(id) || restarter.restarting().includes(id);

  async function switchAccount(id: string, to: string): Promise<SwitchResult> {
    const s = deps.session(id);
    if (!s) return { ok: false, status: 404, error: 'unknown session' };
    const acc = deps.accounts(s);
    const inHost = deps.hostRuns(id);
    const refused = switchRefusal(to, {
      archived: !!s.archivedAt || deps.beingArchived(id),
      accounts: acc,
      pendingTo: pending(id) ? (targets.get(id) ?? '') : null,
      inHost,
      runningOutside: !inHost && deps.runningOutside(id),
    });
    if (refused) return { ok: false, ...refused };
    if (!acc) return { ok: false, status: 409, error: "its agent doesn't have accounts" }; // (refused above: for the type)

    const before = await refusalBeforeStop(s, id);
    if (before) return { ok: false, status: 409, error: `stays on ${acc.current}: ${before}` };

    if (!inHost) {
      // Nothing to stop: the files move and the account is recorded; the next start uses it.
      try {
        const moved = await moveAndRecord(s, to, acc.current);
        deps.note?.(id, `${name(s)}: moved to the ${to} account (${moved} entries moved; its next start uses it)`, 'action');
        deps.changed?.();
        return { ok: true, outcome: 'recorded', moved };
      } catch (err) {
        deps.note?.(id, `couldn't switch: ${msg(err)}`, 'warn');
        return { ok: false, status: 502, error: `stays on ${acc.current}: ${msg(err)}` };
      }
    }

    targets.set(id, to);
    movedBy.delete(id);
    const r = await restarter.request([id]);
    if (r.later.includes(id)) {
      deps.note?.(id, `will move to the ${to} account when its turn ends (it is working or waiting on you)`, 'info');
      return { ok: true, outcome: 'queued' };
    }
    const failed = r.failed.find((f) => f.id === id);
    if (failed) return { ok: false, status: 502, error: failed.error };
    return { ok: true, outcome: 'switched', moved: movedBy.get(id) };
  }

  return {
    switchAccount,
    /** Its turn ended: do the switch that waited for it. */
    turnEnded: (id: string) => restarter.turnEnded(id),
    /** Do the waiting switches that can go now (a turn whose end no hook reported). */
    retry: () => restarter.retry(),
    /** Sessions waiting for their turn to end, and where each goes. */
    waiting: (): Array<{ id: string; to: string }> => restarter.queued().map((id) => ({ id, to: targets.get(id) ?? '' })),
    /** The account a switch waiting for its turn, or being done now, moves it to; null: none. Either way its agent restarts. */
    restartsAnyway: (id: string): string | null => (pending(id) ? (targets.get(id) ?? '') : null),
    /** The account a session is waiting to move to (its turn first), or null. Kept in memory: a work web restart drops it. */
    pendingFor: (id: string): string | null => (restarter.queued().includes(id) ? (targets.get(id) ?? null) : null),
    /**
     * Drop the switch waiting for its turn to end. `running`: it is being done right now (too late to cancel); `none`:
     * nothing waits for it.
     */
    cancel: (id: string): 'cancelled' | 'running' | 'none' => {
      if (restarter.restarting().includes(id)) return 'running';
      const to = targets.get(id);
      if (!restarter.cancel(id)) return 'none';
      targets.delete(id);
      deps.note?.(id, `no longer moves to the ${to ?? 'other'} account: the switch was cancelled`, 'info');
      return 'cancelled';
    },
  };
}

export type AccountSwitcher = ReturnType<typeof createAccountSwitcher>;

/**
 * The switcher's `note` as Activity runs: one run per note, a failure (`warn`) failing it — so a switch that waited for its
 * turn and then couldn't be done lights the Activity dot, rather than passing as a run that went fine.
 */
export function accountSwitchNote(
  activity: Pick<ActivityLog, 'start'>,
  label: (id: string) => string | null,
): NonNullable<AccountSwitchDeps['note']> {
  return (id, text, level) => {
    const name = label(id);
    const run = activity.start('accounts', 'Switching a Claude account');
    run.note(`${name ?? id}: ${text}`, { level, sessionId: name ? id : undefined });
    if (level === 'warn') run.fail(text);
    else run.done(text);
  };
}
