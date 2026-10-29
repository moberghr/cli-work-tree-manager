import { useEffect, useState } from 'react';
import type { AccountsWire } from '../../../core/api-types.js';
import { fetchAccounts } from '../api/client.js';

export interface AccountsState {
  /** The accounts; null until known, or when the server couldn't say: nothing account-related is then offered. */
  data: AccountsWire | null;
  /** Why the last read failed (null once one succeeds): said where an account action can't be offered. */
  error: string | null;
}

/**
 * The agent's accounts, read when the page opens and again when the window gets focus (one is
 * added with `work account add` in a terminal). A failed read keeps what was known and says why.
 */
export function useAccounts(load: () => Promise<AccountsWire> = fetchAccounts): AccountsState {
  const [state, setState] = useState<AccountsState>({ data: null, error: null });
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
  }, [load]);
  return state;
}
