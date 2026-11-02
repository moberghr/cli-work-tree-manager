import { useEffect, useState } from 'react';
import type { AccountSwitchWire, AccountsWire } from '../../../../core/api-types.js';
import { cancelAccountSwitch, fetchAccounts, switchSessionAccount, type SessionSummary } from '../../api/client.js';
import { accountName, accountRow, currentAccount, loginText, pendingText } from '../../state/accounts.js';

interface Props {
  session: SessionSummary;
  /** The session's Claude was moved, queued to move, or will start on the account (the toast says which). */
  onSwitched: (to: string, wire: AccountSwitchWire) => void;
  onClose: () => void;
  /** The switch that waited for its turn was cancelled: it stays on its account. */
  onCancelled?: (to: string) => void;
  /** Test seams; default to GET /api/accounts, POST and DELETE /api/sessions/:id/account. */
  load?: () => Promise<AccountsWire>;
  switchTo?: (sessionId: string, to: string) => Promise<AccountSwitchWire>;
  cancelSwitch?: (sessionId: string) => Promise<void>;
}

/**
 * Claude account… (accounts.ts, POST /api/sessions/:id/account): the logins work
 * knows, the one the session runs on marked, those not logged in shown but not
 * pickable. A switch stops its Claude, moves its conversation across and starts
 * it again, which takes a moment: the dialog says so until it's done. A refusal
 * is shown here.
 */
export function AccountDialog({
  session,
  onSwitched,
  onClose,
  onCancelled,
  load = fetchAccounts,
  switchTo = switchSessionAccount,
  cancelSwitch = cancelAccountSwitch,
}: Props) {
  const [data, setData] = useState<AccountsWire | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = currentAccount(session);

  useEffect(() => {
    let live = true;
    load().then(
      (d) => live && setData(d),
      (err: Error) => live && setLoadError(err.message),
    );
    return () => {
      live = false;
    };
  }, [load]);

  const close = () => !busy && onClose();
  const pending = session.accountPending;

  async function cancel() {
    if (busy || !pending) return;
    setBusy(true);
    setError(null);
    try {
      await cancelSwitch(session.id);
      onCancelled?.(pending);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !pick) return;
    setBusy(true);
    setError(null);
    try {
      const wire = await switchTo(session.id, pick);
      onSwitched(pick, wire);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const name = session.title && session.titleIsYours ? session.title : session.branch;
  return (
    <div
      className="wd-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Claude account of ${session.branch}`}
      onClick={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <form className="wd-modal" onSubmit={submit}>
        <header className="wd-modal-header">
          <h2>Claude account of {name}</h2>
          <button type="button" className="wd-modal-close" onClick={close} aria-label="Close" disabled={busy}>
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <p className="wd-account-note">
            Its conversation moves with it and the terminal stays: its Claude is stopped (after its turn, when it is working) and started
            again on the new account, resuming where it was.
          </p>
          {pending && (
            <p className="wd-account-note wd-account-pending-note" role="status">
              Waiting for its turn to end: {pendingText(pending)}.{' '}
              <button type="button" className="wd-btn-secondary" onClick={() => void cancel()} disabled={busy}>
                Cancel the switch
              </button>
            </p>
          )}
          {data === null && !loadError && <p className="wd-account-note">Loading the accounts…</p>}
          {loadError && (
            <p className="wd-modal-error" role="alert">
              Couldn&apos;t list the accounts: {loadError}
            </p>
          )}
          {data && (
            <ul className="wd-account-list" role="radiogroup" aria-label="Accounts">
              {data.accounts.map((a) => {
                const row = accountRow(a, current);
                return (
                  <li key={a.name}>
                    <label className={'wd-account-row' + (row.disabled ? ' wd-account-row-off' : '')}>
                      <input
                        type="radio"
                        name="account"
                        value={a.name}
                        checked={pick === a.name}
                        disabled={row.disabled || busy}
                        onChange={() => setPick(a.name)}
                      />
                      <span className="wd-account-name">{accountName(a)}</span>
                      <span className="wd-account-dir">{a.dir}</span>
                      <span className={'wd-account-login' + (a.loggedIn === false ? ' wd-account-login-bad' : '')}>{loginText(a)}</span>
                      {row.hint && <span className="wd-account-hint">{row.hint}</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {busy && pick && (
            <p className="wd-account-busy" role="status">
              <span className="wd-spinner" aria-hidden="true" /> Moving it to {pick}…
            </p>
          )}
          {error && (
            <p className="wd-modal-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="wd-modal-footer">
          <button type="button" className="wd-btn-secondary" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="wd-btn-primary" disabled={busy || !pick || !!pending}>
            {busy ? 'Switching…' : 'Switch'}
          </button>
        </footer>
      </form>
    </div>
  );
}
