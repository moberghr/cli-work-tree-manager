import { useEffect, useMemo, useState } from 'react';
import type { AccountsWire } from '../../../../../core/api-types.js';
import { AccountChangeError, addAccount, makeDefaultAccount, removeAccount } from '../../../api/client.js';
import { useAccounts } from '../../../hooks/use-accounts.js';
import { accountPageRows, addAccountProblem, DEFAULT_ACCOUNT, defaultAccountFolder, removeRefusal } from '../../../state/accounts.js';
import { AccountLoginPanel } from '../AccountLoginPanel.js';

/** The calls the page makes (tests swap them). */
export interface AccountsApi {
  load?: () => Promise<AccountsWire>;
  add: (name: string, folder?: string) => Promise<{ dir: string }>;
  makeDefault: (name: string) => Promise<unknown>;
  remove: (name: string, force?: boolean) => Promise<unknown>;
}

const httpAccounts: AccountsApi = { add: addAccount, makeDefault: makeDefaultAccount, remove: removeAccount };

interface Props {
  api?: AccountsApi;
  /** Open with the Add form showing (Claude account…'s "Add another account…", New worktree's link). */
  startAdding?: boolean;
  /** The Add form was shown for that ask (so a later visit doesn't open it again). */
  onAddingShown?: () => void;
  /** The login terminal; a test passes a stand-in. */
  LoginPanel?: typeof AccountLoginPanel;
  /** "now" for the usage line's ages. */
  now?: () => number;
}

/** A removal waiting for "Remove anyway" (archived sessions on it). */
interface Pending {
  name: string;
  text: string;
}

/**
 * Claude accounts (`#/accounts`): every login work knows — its folder, whether it is logged in,
 * its last usage reading, which one new sessions use, who runs on it — and Add account…, Log in,
 * Make default and Remove, with the same core as `work account` (account-admin.ts). Logging in
 * happens in a terminal on this page (AccountLoginPanel), not in yours.
 */
export function AccountsTab({ api = httpAccounts, startAdding, onAddingShown, LoginPanel = AccountLoginPanel, now = Date.now }: Props) {
  const { data, error, reload } = useAccounts(api.load);
  const [adding, setAdding] = useState(!!startAdding);
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending | null>(null);
  const [loggingIn, setLoggingIn] = useState<string | null>(null);

  useEffect(() => {
    if (!startAdding) return;
    setAdding(true);
    onAddingShown?.();
  }, [startAdding, onAddingShown]);

  const rows = useMemo(() => (data ? accountPageRows(data, now()) : []), [data, now]);
  const problem = addAccountProblem(name, data);
  const canManage = data?.canManage !== false;

  const act = (key: string, fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(key);
    setRowError(({ [key]: _, ...rest }) => rest);
    fn()
      .then(
        () => {
          after?.();
          reload();
        },
        (e: Error) => {
          if (key.startsWith('remove:') && e instanceof AccountChangeError && e.sessions.length) {
            const r = removeRefusal(e);
            if (r.canForce) return setPending({ name: key.slice('remove:'.length), text: r.text });
            return setRowError((m) => ({ ...m, [key]: r.text }));
          }
          setRowError((m) => ({ ...m, [key]: e.message }));
        },
      )
      .finally(() => setBusy(null));
  };

  const submitAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n || problem || busy) return;
    act(
      'add',
      () => api.add(n, folder.trim() || undefined),
      () => {
        setAdding(false);
        setName('');
        setFolder('');
        // Straight into its login: an account nobody logged in to is of no use yet.
        setLoggingIn(n);
      },
    );
  };

  if (error && !data) return <div className="wd-tab-empty wd-tab-error">Couldn&apos;t load the Claude accounts: {error}</div>;
  if (!data) return <div className="wd-tab-empty">Loading…</div>;

  return (
    <div className="wd-dash-tab-pane wd-tab-accounts">
      <header className="wd-tab-header">
        <h1>
          Claude accounts <span className="wd-tab-header-muted">{rows.length}</span>
        </h1>
        <div className="wd-tab-controls">
          {canManage && !adding && (
            <button type="button" className="wd-btn-primary" onClick={() => setAdding(true)}>
              Add account…
            </button>
          )}
        </div>
      </header>

      <p className="wd-accounts-intro">
        Each account is a Claude Code login with its own folder, limits and conversations. When one runs out, move a session to another with
        Claude account… (<kbd>⇧C</kbd>) — its conversation goes with it.
        {!canManage && data.manageNote ? ` Here they can only be looked at: ${data.manageNote}.` : ''}
      </p>

      {adding && (
        <form className="wd-accounts-add" onSubmit={submitAdd} aria-label="Add an account">
          <label>
            <span>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="work"
              aria-label="Account name"
              aria-invalid={!!problem}
            />
          </label>
          <label>
            <span>Folder</span>
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={defaultAccountFolder(name)}
              aria-label="Account folder (optional)"
            />
          </label>
          <button type="submit" className="wd-btn-primary" disabled={!name.trim() || !!problem || busy === 'add'}>
            {busy === 'add' ? 'Adding…' : 'Add and log in'}
          </button>
          <button type="button" className="wd-btn-secondary" onClick={() => setAdding(false)} disabled={busy === 'add'}>
            Cancel
          </button>
          {(problem || rowError.add) && (
            <span className="wd-accounts-error" role="alert">
              {problem ?? rowError.add}
            </span>
          )}
        </form>
      )}

      {pending && (
        <div className="wd-repos-confirm wd-accounts-confirm" role="alertdialog" aria-label="Confirm">
          <span>{pending.text}</span>
          <button
            type="button"
            className="wd-btn-danger"
            onClick={() => {
              const n = pending.name;
              setPending(null);
              act(`remove:${n}`, () => api.remove(n, true));
            }}
          >
            Remove anyway
          </button>
          <button type="button" className="wd-btn-secondary" onClick={() => setPending(null)}>
            Cancel
          </button>
        </div>
      )}

      <ul className="wd-accounts-list">
        {rows.map((r) => (
          <li key={r.name} className={'wd-accounts-row' + (r.isDefault ? ' wd-accounts-default' : '')}>
            <span className="wd-accounts-name">
              <span className="wd-account-name">{r.label}</span>
              <span className="wd-account-dir" title={r.dir}>
                {r.dir}
              </span>
            </span>
            <span className={'wd-account-login' + (r.needsLogin ? ' wd-account-login-bad' : '')}>{r.login}</span>
            <span className="wd-accounts-usage">{r.usage}</span>
            <span className="wd-accounts-sessions" title={r.sessionNames.join('\n') || undefined}>
              {r.sessions}
            </span>
            <span className="wd-accounts-actions">
              {canManage && (
                <>
                  <button
                    type="button"
                    className={r.needsLogin ? 'wd-btn-primary' : 'wd-btn-secondary'}
                    onClick={() => setLoggingIn(r.name)}
                    disabled={busy !== null}
                  >
                    {r.needsLogin ? 'Log in' : 'Log in again'}
                  </button>
                  {r.canMakeDefault && (
                    <button
                      type="button"
                      className="wd-btn-secondary"
                      onClick={() => act(`default:${r.name}`, () => api.makeDefault(r.name))}
                      disabled={busy !== null}
                      title="New sessions start on this account"
                    >
                      Make default
                    </button>
                  )}
                  {r.name !== DEFAULT_ACCOUNT && (
                    <button
                      type="button"
                      className="wd-btn-secondary"
                      onClick={() => act(`remove:${r.name}`, () => api.remove(r.name))}
                      disabled={busy !== null || !r.canRemove}
                      title={r.canRemove ? 'work forgets it; its folder stays as it is' : `Can't remove it: ${r.removeWhy}`}
                    >
                      Remove
                    </button>
                  )}
                </>
              )}
            </span>
            {(rowError[`remove:${r.name}`] ?? rowError[`default:${r.name}`]) && (
              <span className="wd-accounts-error" role="alert">
                {rowError[`remove:${r.name}`] ?? rowError[`default:${r.name}`]}
              </span>
            )}
          </li>
        ))}
      </ul>

      {loggingIn && (
        <LoginPanel
          name={loggingIn}
          onClose={() => {
            setLoggingIn(null);
            reload();
          }}
        />
      )}
    </div>
  );
}
