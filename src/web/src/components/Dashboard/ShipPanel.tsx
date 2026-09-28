import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchShipPreflight,
  ship,
  type MergeMethod,
  type RepoShipState,
  type SessionSummary,
  type ShipAction,
  type ShipPreflight,
  type ShipResult,
} from '../../api/client.js';

interface Props {
  session: SessionSummary;
  onClose: () => void;
  /** The merge went through and the server archived the session. */
  onMerged: () => void;
}

/** The server replies `{"error": "..."}`; surface just the message. */
function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(msg) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* not JSON */
  }
  return msg;
}

const BUSY_LABEL: Record<ShipAction, string> = {
  push: 'Pushing…',
  'create-pr': 'Creating PR…',
  merge: 'Merging…',
};

/** What the preflight allows, across every repo of the session. */
export function shipAvailability(pre: ShipPreflight) {
  const repos = pre.repos;
  const dirty = repos.filter((r) => r.dirtyFiles > 0);
  const needsPush = repos.filter((r) => !r.hasUpstream || (r.ahead ?? 0) > 0);
  const noPr = repos.filter((r) => !r.pr || r.pr.state === 'CLOSED');
  const openPrs = repos.filter((r) => r.pr?.state === 'OPEN');
  const blocked = openPrs.filter((r) => r.mergeBlockers.length > 0 || r.pr!.isDraft);
  const clean = dirty.length === 0;
  return {
    dirty,
    canPush: clean && needsPush.length > 0,
    canCreatePr: clean && noPr.length > 0 && repos.every((r) => !r.ghError),
    // Repos without an open PR (a group sub-repo with no changes) are
    // simply not merged; every OPEN one must be mergeable.
    canMerge: clean && openPrs.length > 0 && blocked.length === 0,
    openPrs,
  };
}

/**
 * Ship a session: push → open a PR → merge, per repo (groups ship every
 * repo). Starts with a preflight so it only offers what's valid right now;
 * a dirty tree blocks everything ("commit or stash first"). Merging is
 * outward-facing and irreversible, so it needs an explicit confirm, and the
 * server merges at the head SHA the preflight saw (refused if it moved).
 */
export function ShipPanel({ session, onClose, onMerged }: Props) {
  const [pre, setPre] = useState<ShipPreflight | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<ShipAction | null>(null);
  const [results, setResults] = useState<ShipResult[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState(false);
  const [method, setMethod] = useState<MergeMethod>('squash');
  const [confirming, setConfirming] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchShipPreflight(session.id).then(
      (p) => {
        setPre(p);
        setLoading(false);
      },
      (err) => {
        setLoadError(errorText(err));
        setLoading(false);
      },
    );
  }, [session.id]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  useEffect(() => cancelRef.current?.focus(), []);

  const run = (action: ShipAction) => {
    setBusy(action);
    setActionError(null);
    setResults(null);
    ship(session.id, {
      action,
      ...(action === 'merge' ? { method } : {}),
      ...(action === 'create-pr' ? { draft } : {}),
    }).then(
      (res) => {
        setBusy(null);
        setConfirming(false);
        setResults(res.results);
        if (res.archived) {
          onMerged();
          return;
        }
        load();
      },
      (err) => {
        setBusy(null);
        setConfirming(false);
        setActionError(errorText(err));
      },
    );
  };

  const avail = pre ? shipAvailability(pre) : null;
  const disabled = busy !== null || loading;

  return (
    <div
      className="wd-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="wd-modal wd-ship-panel" role="dialog" aria-label="Ship session" aria-busy={loading || busy !== null}>
        <div className="wd-modal-header">
          <h2>
            Ship {session.target} · {session.branch}
          </h2>
          <button type="button" className="wd-modal-close" onClick={onClose} disabled={!!busy} aria-label="Close">
            ×
          </button>
        </div>
        <div className={'wd-modal-body' + (busy || loading ? ' wd-ship-dim' : '')}>
          {loading && !pre && (
            <p className="wd-ship-progress" role="status">
              <span className="wd-spinner" aria-hidden /> Checking branch, upstream and PR…
            </p>
          )}
          {loadError && <p className="wd-modal-error" role="alert">{loadError}</p>}
          {pre?.repos.map((r) => <RepoState key={r.path} repo={r} />)}
          {busy && (
            <p className="wd-ship-progress" role="status">
              <span className="wd-spinner" aria-hidden /> {BUSY_LABEL[busy]}
            </p>
          )}
          {actionError && <p className="wd-modal-error" role="alert">{actionError}</p>}
          {results && (
            <ul className="wd-ship-results">
              {results.map((r) => (
                <li key={r.repo} className={r.ok ? 'wd-ship-ok' : 'wd-ship-fail'}>
                  {r.ok ? '✓' : '✗'} <strong>{r.repo}</strong> — {r.message}
                  {r.url && (
                    <>
                      {' '}
                      <a href={r.url} target="_blank" rel="noreferrer">open</a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {avail?.dirty.length ? (
            <p className="wd-modal-error" role="alert">
              Uncommitted changes in {avail.dirty.map((r) => r.name).join(', ')} — commit or stash first.
            </p>
          ) : null}
          {confirming && avail && (
            <div className="wd-ship-confirm" role="alertdialog" aria-label="Confirm merge">
              <p>
                Merge {avail.openPrs.map((r) => `${r.name} #${r.pr!.number}`).join(', ')} with{' '}
                <strong>{method}</strong>? This can’t be undone from here. The session is archived afterwards.
              </p>
              <div className="wd-ship-confirm-actions">
                <button type="button" className="wd-btn-secondary" onClick={() => setConfirming(false)} disabled={disabled}>
                  Cancel
                </button>
                <button type="button" className="wd-btn-danger" onClick={() => run('merge')} disabled={disabled}>
                  Confirm merge
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="wd-modal-footer wd-ship-footer">
          <button type="button" ref={cancelRef} className="wd-btn-secondary" onClick={onClose} disabled={!!busy}>
            Close
          </button>
          <button
            type="button"
            className="wd-btn-secondary"
            disabled={disabled || !avail?.canPush}
            onClick={() => run('push')}
            title="Publish the branch (git push, setting upstream if needed)"
          >
            Push
          </button>
          <span className="wd-ship-group">
            <label className="wd-ship-inline">
              <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={disabled} />{' '}
              draft
            </label>
            <button
              type="button"
              className="wd-btn-secondary"
              disabled={disabled || !avail?.canCreatePr}
              onClick={() => run('create-pr')}
              title="Push if needed, then open a pull request"
            >
              Create PR
            </button>
          </span>
          <span className="wd-ship-group">
            <select
              aria-label="Merge method"
              value={method}
              onChange={(e) => setMethod(e.target.value as MergeMethod)}
              disabled={disabled || !avail?.canMerge}
            >
              <option value="squash">squash</option>
              <option value="merge">merge commit</option>
              <option value="rebase">rebase</option>
            </select>
            <button
              type="button"
              className="wd-btn-primary"
              disabled={disabled || !avail?.canMerge || confirming}
              onClick={() => setConfirming(true)}
              title="Merge the open PR — asks for confirmation"
            >
              Merge…
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function RepoState({ repo: r }: { repo: RepoShipState }) {
  const upstream = !r.hasUpstream
    ? 'not pushed'
    : r.ahead || r.behind
      ? [r.ahead ? `${r.ahead} ahead` : '', r.behind ? `${r.behind} behind` : ''].filter(Boolean).join(', ')
      : 'up to date';
  return (
    <section className="wd-ship-repo">
      <header>
        <strong>{r.name}</strong> <span className="wd-tab-header-muted">{r.branch}</span>
      </header>
      <ul className="wd-ship-facts">
        <li className={r.dirtyFiles > 0 ? 'wd-ship-bad' : ''}>
          {r.dirtyFiles > 0 ? `${r.dirtyFiles} uncommitted file${r.dirtyFiles === 1 ? '' : 's'}` : 'working tree clean'}
        </li>
        <li>{upstream}</li>
        <li>
          {r.pr ? (
            <>
              <a href={r.pr.url} target="_blank" rel="noreferrer">#{r.pr.number}</a>{' '}
              {r.pr.state.toLowerCase()}
              {r.pr.isDraft ? ' · draft' : ''} · checks {r.pr.checks} · {r.pr.mergeStateStatus.toLowerCase()}
            </>
          ) : (
            'no PR yet'
          )}
        </li>
        {r.ghError && <li className="wd-ship-bad">{r.ghError}</li>}
      </ul>
      {r.mergeBlockers.length > 0 && (
        <ul className="wd-ship-blockers" aria-label={`Why ${r.name} can't merge`}>
          {r.mergeBlockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
