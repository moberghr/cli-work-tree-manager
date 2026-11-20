import { useEffect, useRef, useState } from 'react';
import { startAccountLogin, stopAccountLogin } from '../../api/client.js';
import { PtyView } from '../Terminal/LazyPtyView.js';

interface Props {
  /** The account to log in to. */
  name: string;
  /** Closed (Done, ×): its terminal was asked to stop. */
  onClose: () => void;
  /** Test seams; default to POST / DELETE /api/accounts/:name/login. */
  start?: (name: string) => Promise<string>;
  stop?: (name: string) => Promise<void>;
}

/**
 * An account's login terminal (the Accounts page's Add and Log in): Claude Code on that account, started in the PTY host
 * so it shows here, where you type /login and follow it. It starts in its normal permission mode, as every Claude work
 * starts, and is stopped when this closes (work's skills then go into a new account's folder). Not on Esc or a click
 * outside: the terminal needs Esc, and a login half done shouldn't vanish.
 */
export function AccountLoginPanel({ name, onClose, start = startAccountLogin, stop = stopAccountLogin }: Props) {
  const [id, setId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closed = useRef(false);

  useEffect(() => {
    let live = true;
    start(name).then(
      (x) => live && setId(x),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [name, start]);

  const close = () => {
    if (closed.current) return;
    closed.current = true;
    // Best effort: a terminal left running is stopped with the host's next restart, never restored.
    stop(name).catch(() => undefined);
    onClose();
  };

  return (
    <div className="wd-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Log in to the ${name} account`}>
      <div className="wd-modal wd-account-login-panel">
        <header className="wd-modal-header">
          <h2>Log in to {name}</h2>
          <button type="button" className="wd-modal-close" onClick={close} aria-label="Close">
            ×
          </button>
        </header>
        <p className="wd-account-note">
          Claude Code on this account’s folder. Type <code>/login</code> and follow it (a browser window opens to sign in), then press Done.
          A new folder may first ask whether to trust it.
        </p>
        <div className="wd-account-login-term">
          {error ? (
            <p className="wd-modal-error" role="alert">
              Couldn&apos;t start it: {error}
            </p>
          ) : id ? (
            <PtyView sessionId={id} />
          ) : (
            <p className="wd-account-note">
              <span className="wd-spinner" aria-hidden="true" /> Starting Claude Code…
            </p>
          )}
        </div>
        <footer className="wd-modal-footer">
          <button type="button" className="wd-btn-primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
