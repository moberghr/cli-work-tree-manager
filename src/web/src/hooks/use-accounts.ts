import { useCallback, useEffect, useState } from 'react';
import type { AccountsWire } from '../../../core/api-types.js';
import { fetchAccounts } from '../api/client.js';
import { useSse } from '../api/events.js';

export interface AccountsState {
  /** The accounts; null until known, or when the server couldn't say: nothing account-related is then offered. */
  data: AccountsWire | null;
  /** Why the last read failed (null once one succeeds): said where an account action can't be offered. */
  error: string | null;
}

/** The server's event stream, where there is one to listen to (none in a test's DOM). */
const EVENTS = typeof EventSource === 'undefined' ? null : '/events';

/**
 * The agent's accounts, read when the page opens, again when one changes (`accounts-changed`: the
 * Accounts page) and when the window gets focus (one added with `work account add` in a terminal).
 * A failed read keeps what was known and says why. `reload` reads them again now.
 */
export function useAccounts(load: () => Promise<AccountsWire> = fetchAccounts): AccountsState & { reload: () => void } {
  const [state, setState] = useState<AccountsState>({ data: null, error: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useSse(EVENTS, { events: { 'accounts-changed': reload } });
  useEffect(() => {
    let live = true;
    const read = () => {
      load().then(
        (a) => live && setState({ data: a, error: null }),
        (err: unknown) => live && setState((cur) => ({ data: cur.data, error: err instanceof Error ? err.message : String(err) })),
      );
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
    };
  }, [load, tick]);
  return { ...state, reload };
}
