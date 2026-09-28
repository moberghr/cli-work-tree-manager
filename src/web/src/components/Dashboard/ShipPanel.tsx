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

/** A repo that can be merged right now: open PR, nothing blocking. */
export function isMergeable(r: RepoShipState): boolean {
  return !r.done && r.pr?.state === 'OPEN' && r.mergeBlockers.length === 0;
}

/**
 * What the preflight allows. Done repos (merged, or never touched) are out
 * of the picture entirely — in a group, backend can be merged and done
 * while frontend is still in review, and that must not block anything.
 */
export function shipAvailability(pre: ShipPreflight) {
  const active = pre.repos.filter((r) => !r.done);
  const dirty = active.filter((r) => r.dirtyFiles > 0);
  const shipping = active.filter((r) => r.commitsVsBase !== 0 || r.pr);
  const needsPush = shipping.filter((r) => !r.hasUpstream || (r.ahead ?? 0) > 0 || !r.tracksRemote);
  const noPr = shipping.filter((r) => !r.pr || r.pr.state === 'CLOSED');
  const mergeable = active.filter(isMergeable);
  const clean = dirty.length === 0;
  return {
    dirty,
    active,
    mergeable,
    canPush: clean && needsPush.length > 0,
    canCreatePr: clean && noPr.length > 0 && shipping.every((r) => !r.ghError),
    allDone: pre.repos.length > 0 && active.length === 0,
  };
}

/**
 * Ship a session: push → open a PR → merge, per repo. Starts with a
 * preflight so it only offers what's valid right now.
 *
 * Merging is outward-facing and irreversible, so: you pick the repos (all
 * mergeable ones are pre-selected; a group can be shipped in parts), an
 * explicit confirm says exactly what will merge and whether the session
 * will be archived, and the request carries the PR head SHAs shown here —
 * the server refuses the whole merge if any of them moved.
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const cancelRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchShipPreflight(session.id).then(
      (p) => {
        setPre(p);
        // Fresh preflight → fresh selection: every mergeable repo.
        setSelected(new Set(p.repos.filter(isMergeable).map((r) => r.name)));
        setConfirming(false);
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

  const avail = pre ? shipAvailability(pre) : null;
  const toMerge = avail ? avail.mergeable.filter((r) => selected.has(r.name)) : [];
  // Archived afterwards only if this merge leaves nothing undone.
  const archivesAfter = !!avail && toMerge.length > 0 && toMerge.length === avail.active.length;

  const run = (action: ShipAction) => {
    setBusy(action);
    setActionError(null);
    setResults(null);
    const body =
      action === 'merge'
        ? { action, method, repos: toMerge.map((r) => ({ name: r.name, headSha: r.pr!.headSha })) }
        : { action, ...(action === 'create-pr' ? { draft } : {}) };
    ship(session.id, body).then(
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

  const toggle = (name: string) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const disabled = busy !== null || loading;
  const multi = (pre?.repos.length ?? 0) > 1;

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
          {pre?.repos.map((r) => (
            <RepoState
              key={r.path}
              repo={r}
              selectable={multi && isMergeable(r)}
              selected={selected.has(r.name)}
              onToggle={() => toggle(r.name)}
              disabled={disabled}
            />
          ))}
          {avail?.allDone && (
            <p className="wd-ship-ok" role="status">Every repository is merged or untouched — nothing left to ship.</p>
          )}
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
          {confirming && toMerge.length > 0 && (
            <div className="wd-ship-confirm" role="alertdialog" aria-label="Confirm merge">
              <p>
                Merge {toMerge.map((r) => `${r.name} #${r.pr!.number} (${r.pr!.headSha.slice(0, 7)})`).join(', ')} with{' '}
                <strong>{method}</strong>? This can’t be undone from here.{' '}
                {archivesAfter
                  ? 'Every repository is then done, so the session is archived.'
                  : `${avail!.active.length - toMerge.length} other repositor${avail!.active.length - toMerge.length === 1 ? 'y stays' : 'ies stay'} open — the session stays until everything is done.`}
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
              disabled={disabled || toMerge.length === 0}
            >
              <option value="squash">squash</option>
              <option value="merge">merge commit</option>
              <option value="rebase">rebase</option>
            </select>
            <button
              type="button"
              className="wd-btn-primary"
              disabled={disabled || toMerge.length === 0 || confirming}
              onClick={() => setConfirming(true)}
              title={
                multi
                  ? 'Merge the selected repositories — asks for confirmation'
                  : 'Merge the open PR — asks for confirmation'
              }
            >
              {multi && toMerge.length > 0 ? `Merge ${toMerge.length}…` : 'Merge…'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function RepoState({
  repo: r,
  selectable,
  selected,
  onToggle,
  disabled,
}: {
  repo: RepoShipState;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const upstream = !r.hasUpstream
    ? 'not pushed'
    : r.ahead || r.behind
      ? [r.ahead ? `${r.ahead} ahead` : '', r.behind ? `${r.behind} behind` : ''].filter(Boolean).join(', ')
      : 'up to date';
  return (
    <section className={'wd-ship-repo' + (r.done ? ' wd-ship-repo-done' : '')}>
      <header>
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
            disabled={disabled}
            aria-label={`Merge ${r.name}`}
          />
        )}{' '}
        <strong>{r.name}</strong> <span className="wd-tab-header-muted">{r.branch}</span>
        {r.done && (
          <span className="wd-ship-done">
            {' '}
            {r.doneReason === 'merged' ? '✓ merged' : '— untouched, nothing to ship'}
          </span>
        )}
      </header>
      {!r.done && (
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
      )}
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
