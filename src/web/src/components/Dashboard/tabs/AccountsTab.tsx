import { useEffect, useMemo, useState } from 'react';
import type { AccountSetupWire, AccountsWire } from '../../../../../core/api-types.js';
import {
  AccountChangeError,
  addAccount,
  copyAccountSetup,
  fetchAccountSetupPlan,
  makeDefaultAccount,
  moveAllSessionsToAccount,
  removeAccount,
} from '../../../api/client.js';
import { restartAgents } from '../../../api/panes.js';
import { restartAllNote } from '../../../state/agent-restart-view.js';
import { useAccounts } from '../../../hooks/use-accounts.js';
import {
  accountPageRows,
  addAccountProblem,
  DEFAULT_ACCOUNT,
  defaultAccountFolder,
  removeRefusal,
  sessionsElsewhere,
  setupItemLine,
  setupSources,
} from '../../../state/accounts.js';
import { AccountLoginPanel } from '../AccountLoginPanel.js';

/** The calls the page makes (tests swap them). */
export interface AccountsApi {
  load?: () => Promise<AccountsWire>;
  add: (name: string, folder?: string) => Promise<{ dir: string }>;
  makeDefault: (name: string) => Promise<unknown>;
  remove: (name: string, force?: boolean) => Promise<unknown>;
  /** Move every session on another account to this one; resolves with what happened, in a line. */
  moveAll: (name: string) => Promise<{ summary: string }>;
  /** What copying `from`'s setup to `to` would do, and doing it. */
  setupPlan: (to: string, from: string) => Promise<AccountSetupWire>;
  copySetup: (to: string, from: string) => Promise<AccountSetupWire>;
  /** Restart every session's agent on its own conversation; resolves with what happened, in a line. */
  restartAll: () => Promise<{ text: string; error?: boolean }>;
}

const httpAccounts: AccountsApi = {
  add: addAccount,
  makeDefault: makeDefaultAccount,
  remove: removeAccount,
  moveAll: moveAllSessionsToAccount,
  setupPlan: fetchAccountSetupPlan,
  copySetup: copyAccountSetup,
  restartAll: () => restartAgents({ all: true }).then(restartAllNote),
};

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
  /** What the last "Restart all Claudes" did. */
  const [restarted, setRestarted] = useState<{ text: string; error?: boolean } | null>(null);
  /** A setup copy shown before it is done (its plan), then with how each thing went. */
  const [setup, setSetup] = useState<(AccountSetupWire & { done?: boolean }) | null>(null);
  /** What the last "Move all sessions here" did, by account. */
  const [movedNote, setMovedNote] = useState<Record<string, string>>({});

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
          <button
            type="button"
            className="wd-btn-secondary"
            onClick={() => act('restart-all', () => api.restartAll().then(setRestarted))}
            disabled={busy !== null}
            title="Restarts every session's Claude on its own conversation, so each reads its settings, plugins and MCP servers again: an idle one at once, a working one when its turn ends. Use it after you turn a plugin on or off, or change Claude's setup."
          >
            {busy === 'restart-all' ? 'Restarting…' : 'Restart all Claudes'}
          </button>
          {canManage && !adding && (
            <button type="button" className="wd-btn-primary" onClick={() => setAdding(true)}>
              Add account…
            </button>
          )}
        </div>
      </header>

      {(restarted ?? (rowError['restart-all'] ? { text: rowError['restart-all'], error: true } : null)) && (
        <p className={'wd-start-note' + ((restarted?.error ?? !!rowError['restart-all']) ? ' wd-accounts-error' : '')} role="status">
          {restarted?.text ?? rowError['restart-all']}
        </p>
      )}
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

      {setup && (
        <div className="wd-accounts-setup" role="dialog" aria-label="Copy setup">
          <p>
            <strong>{setup.summary}</strong>
          </p>
          {setup.items.length > 0 && (
            <ul>
              {setup.items.map((i) => (
                <li key={`${i.kind}:${i.name}`} className={i.ok === false ? 'wd-accounts-error' : undefined}>
                  {setupItemLine(i)}
                </li>
              ))}
            </ul>
          )}
          {!setup.done && setup.items.length > 0 && (
            <p className="wd-start-note">
              Logins and tokens are never copied, nor conversations. Nothing on {setup.to} is deleted. Plugins are installed from their
              marketplaces, which can take a minute.
            </p>
          )}
          {!setup.done && setup.items.length > 0 && (
            <button
              type="button"
              className="wd-btn-primary"
              disabled={busy !== null}
              onClick={() =>
                act(`setup:${setup.to}`, () => api.copySetup(setup.to, setup.from).then((r) => setSetup({ ...r, done: true })))
              }
            >
              {busy === `setup:${setup.to}` ? 'Copying…' : `Copy to ${setup.to}`}
            </button>
          )}
          <button type="button" className="wd-btn-secondary" onClick={() => setSetup(null)} disabled={busy === `setup:${setup.to}`}>
            {setup.done || setup.items.length === 0 ? 'Close' : 'Cancel'}
          </button>
          {rowError[`setup:${setup.to}`] && (
            <span className="wd-accounts-error" role="alert">
              {rowError[`setup:${setup.to}`]}
            </span>
          )}
        </div>
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
                  {data &&
                    setupSources(data, r.name).map((from) => (
                      <button
                        key={from}
                        type="button"
                        className="wd-btn-secondary"
                        onClick={() => act(`plan:${r.name}`, () => api.setupPlan(r.name, from).then(setSetup))}
                        disabled={busy !== null}
                        title={`Shows what ${r.name} lacks of ${from}'s setup (its instructions, agents, commands, settings, MCP servers, plugins), then copies it INTO ${r.name} when you say so. Never a login.`}
                      >
                        Copy setup from {from}…
                      </button>
                    ))}
                  {data && sessionsElsewhere(data, r.name) > 0 && (
                    <button
                      type="button"
                      className="wd-btn-secondary"
                      onClick={() =>
                        act(`moveall:${r.name}`, () =>
                          api.moveAll(r.name).then((x) => setMovedNote((m) => ({ ...m, [r.name]: x.summary }))),
                        )
                      }
                      disabled={busy !== null}
                      title={`Moves the ${sessionsElsewhere(data, r.name)} session(s) on other accounts to this one, with their conversations: an idle Claude restarts on it, a working one switches when its turn ends`}
                    >
                      {busy === `moveall:${r.name}` ? 'Moving…' : 'Move all sessions here'}
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
            {(rowError[`remove:${r.name}`] ??
              rowError[`default:${r.name}`] ??
              rowError[`moveall:${r.name}`] ??
              rowError[`plan:${r.name}`]) && (
              <span className="wd-accounts-error" role="alert">
                {rowError[`remove:${r.name}`] ??
                  rowError[`default:${r.name}`] ??
                  rowError[`moveall:${r.name}`] ??
                  rowError[`plan:${r.name}`]}
              </span>
            )}
            {movedNote[r.name] && (
              <span className="wd-start-note wd-accounts-moved" role="status">
                {movedNote[r.name]}
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
