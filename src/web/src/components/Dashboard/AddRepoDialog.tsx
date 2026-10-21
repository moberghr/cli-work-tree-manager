import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { addRepoToSession, fetchProjects } from '../../api/panes.js';
import type { AddRepoWire } from '../../../../core/api-types.js';
import { addableRepos, headerRepos } from '../../state/add-repo.js';

interface Props {
  session: SessionSummary;
  /** The repo is in the session folder (the toast says where). */
  onAdded: (alias: string, wire: AddRepoWire) => void;
  onClose: () => void;
}

/**
 * Add a repo… to a session folder (add-repo.ts, POST /api/sessions/:id/repos):
 * one of your enrolled repos (the New worktree dialog's list, /api/projects)
 * not in the session yet, checked out into its folder on its branch — the
 * branch the repo has, else made from the base you give (default: the repo's
 * own checkout's branch). Checking it out takes a few seconds, so the dialog
 * says so until it's done; a refusal is shown here.
 */
export function AddRepoDialog({ session, onAdded, onClose }: Props) {
  const [repos, setRepos] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pick, setPick] = useState('');
  const [base, setBase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  const inSession = headerRepos(session);

  useEffect(() => {
    let cancelled = false;
    fetchProjects().then(
      (p) => {
        if (cancelled) return;
        const list = addableRepos(
          p.singles.map((x) => x.name),
          inSession,
        );
        setRepos(list);
        setPick((cur) => cur || list[0] || '');
      },
      (err: Error) => !cancelled && setLoadError(err.message),
    );
    return () => {
      cancelled = true;
    };
    // The session's repos are read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (repos?.length) first.current?.focus();
  }, [repos]);

  const close = () => !busy && onClose();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !pick) return;
    setBusy(true);
    setError(null);
    try {
      const w = await addRepoToSession(session.id, pick, base.trim() || undefined);
      onAdded(pick, w);
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
      aria-label={`Add a repo to ${session.branch}`}
      onClick={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <form className="wd-modal" onSubmit={submit}>
        <header className="wd-modal-header">
          <h2>Add a repo to {name}</h2>
          <button type="button" className="wd-modal-close" onClick={close} aria-label="Close" disabled={busy}>
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <p className="wd-add-repo-note">
            Checked out into the session&apos;s folder on <code>{session.branch}</code> — the branch the repo has, else a new one made from
            the base below. Its Claude is told; nothing restarts.
            {inSession.length ? ` In it now: ${inSession.join(' · ')}.` : ''}
          </p>
          {repos === null && !loadError && <p className="wd-add-repo-note">Loading your repos…</p>}
          {loadError && (
            <p className="wd-modal-error" role="alert">
              Couldn&apos;t list your repos: {loadError}
            </p>
          )}
          {repos !== null && repos.length === 0 && (
            <p className="wd-add-repo-note">Every repo you have is in this session already. Add another on the Repos page first.</p>
          )}
          {repos !== null && repos.length > 0 && (
            <>
              <label className="wd-modal-row">
                <span>Repo</span>
                <select ref={first} value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
                  {repos.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <label className="wd-modal-row">
                <span>Base branch (optional)</span>
                <input
                  type="text"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  placeholder="When the branch is new: the repo's own checkout's branch"
                  disabled={busy}
                />
              </label>
            </>
          )}
          {busy && (
            <p className="wd-add-repo-busy" role="status">
              <span className="wd-spinner" aria-hidden="true" /> Checking {pick} out into the session folder…
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
          <button type="submit" className="wd-btn-primary" disabled={busy || !pick}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </footer>
      </form>
    </div>
  );
}
