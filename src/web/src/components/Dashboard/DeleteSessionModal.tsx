import { useRef, useState } from 'react';
import type { SessionSummary } from '../../api/client.js';
import { removeWorktree, type RemoveWorktreeOptions } from '../../api/panes.js';
import { Modal } from '../Review/Modal.js';

interface Props {
  session: SessionSummary;
  /** Called after the server confirmed the delete. */
  onDeleted: (sessionId: string) => void;
  onClose: () => void;
}

/** The server replies `{"error": "..."}`; postJson surfaces the raw body. */
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

/**
 * Confirmation for deleting a session. Two outcomes:
 *   - "Delete worktree" — `git worktree remove` every path (optionally
 *     forced past uncommitted/unpushed work), then forget the session.
 *   - "Forget session only" — drop it from history; the files stay. Also
 *     the escape hatch when the worktree can't be removed.
 * The branch itself is never deleted. Cancel holds the initial focus so a
 * stray Enter can't destroy anything.
 */
export function DeleteSessionModal({ session, onDeleted, onClose }: Props) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function run(opts: RemoveWorktreeOptions) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeWorktree(session.id, opts);
      onDeleted(session.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Delete session"
      onClose={busy ? () => {} : onClose}
      primaryRef={cancelRef}
      actions={
        <>
          <button
            type="button"
            ref={cancelRef}
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => run({ sessionOnly: true })}
            disabled={busy}
            title="Remove from the dashboard and history; leave the files on disk"
          >
            Forget session only
          </button>
          <button
            type="button"
            className="wd-btn-danger"
            onClick={() => run({ force })}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete worktree'}
          </button>
        </>
      }
    >
      <p>
        Remove the worktree for{' '}
        <code>
          {session.target}/{session.branch}
        </code>{' '}
        and forget the session. The branch itself is kept. Any Claude terminal{' '}
        <code>work web</code> opened for it is stopped.
      </p>
      {session.paths.length > 0 && (
        <ul className="wd-delete-paths">
          {session.paths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
      )}
      <label className="wd-delete-force">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
          disabled={busy}
        />{' '}
        Force — discard uncommitted changes and unpushed commits, and stop its Claude even mid-turn (replies to post and undelivered notes go too)
      </label>
      {error && (
        <p className="wd-delete-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
