import type { Restarter } from '../pty/agent-restart.js';
import type { AccountSwitcher } from './account-switch.js';

/**
 * How work web ties the switch of account (account-switch.ts) to the rest: a turn's end and the periodic sweep reach both
 * the agent restarter and the switcher, the session rows say where a switch is going, and the two never restart one agent
 * twice — a switch that runs drops an agent restart waiting for the same turn, and an agent restart asked for while a
 * switch waits (or runs) is folded into it. Made before either exists (each needs the other's half at construction),
 * then `connect`ed.
 */
export function createAccountSwitchLink() {
  let restarter: Pick<Restarter, 'turnEnded' | 'retry' | 'cancel'> | null = null;
  let switcher: Pick<AccountSwitcher, 'turnEnded' | 'retry' | 'pendingFor' | 'restartsAnyway'> | null = null;
  return {
    connect(r: NonNullable<typeof restarter>, s: NonNullable<typeof switcher>): void {
      restarter = r;
      switcher = s;
    },
    /** The agent restarter's `foldedInto`: a switch that waits or runs restarts it anyway. */
    foldedInto: (id: string): string | null => {
      const to = switcher?.restartsAnyway(id) ?? null;
      return to === null ? null : `its switch to the ${to || 'other'} account`;
    },
    /** The switcher's `cancelRestart`. */
    cancelRestart: (id: string): boolean => restarter?.cancel(id) ?? false,
    /** A session's turn ended: a restart or a switch that waited for it goes now (after its hooks have run). */
    turnEnded(id: string): void {
      restarter?.turnEnded(id);
      switcher?.turnEnded(id);
    },
    /** The sweep: the ones waiting on a turn whose end no hook reported. Never rejects. */
    async retry(): Promise<void> {
      await restarter?.retry().catch(() => {});
      await switcher?.retry().catch(() => {});
    },
    /** The account a session waits to move to (SessionWire.accountPending), or null. */
    pendingFor: (id: string): string | null => switcher?.pendingFor(id) ?? null,
  };
}

export type AccountSwitchLink = ReturnType<typeof createAccountSwitchLink>;
