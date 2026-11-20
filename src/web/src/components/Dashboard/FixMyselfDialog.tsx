import { useState } from 'react';
import type { PrReviewWire, ReviewFixResultWire } from '../../../../core/api-types.js';
import { fixReviewMyself } from '../../api/panes.js';
import { pendingDrafts } from '../../state/review-view.js';
import { useBackdropClose } from '../../hooks/use-backdrop-close.js';

interface Props {
  review: PrReviewWire;
  /** The session has the comments (made for them, or the one already on the branch). */
  onDone: (out: ReviewFixResultWire) => void;
  onClose: () => void;
}

/**
 * Fix it myself… (Reviews tab, beside Submit): the review's pending drafts, each with a tick (all ticked to start). The
 * ticked ones leave the review for a session on the PR's own branch — Start's Work on it, or the live session already
 * on it, told by a note — which makes them, builds, tests, commits and asks you before pushing. The unticked stay
 * drafts; your verdict and summary stay too, to Approve once you pushed.
 */
export function FixMyselfDialog({ review, onDone, onClose }: Props) {
  const drafts = pendingDrafts(review);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(drafts.map((d) => d.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => !busy && onClose();
  const backdrop = useBackdropClose(close);
  const toggle = (id: string) =>
    setTicked((t) => {
      const n = new Set(t);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const picked = drafts.filter((d) => ticked.has(d.id)).map((d) => d.id);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !picked.length) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await fixReviewMyself(review.repo, review.number, picked));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div
      className="wd-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Fix it myself: #${review.number}`}
      onMouseDown={backdrop.onMouseDown}
      onClick={backdrop.onClick}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <form className="wd-modal" onSubmit={submit}>
        <header className="wd-modal-header">
          <h2>Fix it myself</h2>
          <button type="button" className="wd-modal-close" onClick={close} aria-label="Close" disabled={busy}>
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <p className="wd-add-repo-note">
            The ticked comments leave the review and go to a session on <code>{review.branch}</code>, @{review.author}&apos;s branch: it
            makes them, builds, runs the tests and commits, then asks you before pushing. It posts nothing. The rest stay drafts, and you
            can still submit your verdict once you pushed.
          </p>
          <ul className="wd-fix-myself-list">
            {drafts.map((d) => (
              <li key={d.id}>
                <label>
                  <input type="checkbox" checked={ticked.has(d.id)} onChange={() => toggle(d.id)} disabled={busy} />{' '}
                  <span className="wd-start-note">
                    {d.path}:{d.line} · {d.by === 'you' ? 'yours' : 'AI'}
                  </span>
                  <div>{d.body}</div>
                </label>
              </li>
            ))}
          </ul>
          {busy && (
            <p className="wd-add-repo-busy" role="status">
              <span className="wd-spinner" aria-hidden="true" /> Opening a session on {review.branch}…
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
          <button type="submit" className="wd-btn-primary" disabled={busy || !picked.length}>
            {busy ? 'Opening…' : `Fix ${picked.length} myself`}
          </button>
        </footer>
      </form>
    </div>
  );
}
