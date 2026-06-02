import { useEffect, useRef, useState } from 'react';
import {
  openInEditor,
  rebaseWorktree,
  removeWorktree,
  syncWorktree,
} from '../../api/panes.js';

interface Props {
  sessionId: string;
  /** Label shown in confirm-remove ("target · branch"). */
  label: string;
  /** Optional callback after the worktree is removed — caller drops the
   *  session from any Active set, navigates away, etc. */
  onRemoved?: () => void;
}

/**
 * Three-dot menu next to each session row. Wraps the per-session
 * actions surfaced in `work dash` — git fetch + pull, rebase on
 * detected parent, open in VS Code, and remove worktree (with confirm).
 *
 * Click-outside closes the menu; Escape closes it; the trigger button
 * stops event propagation so clicking the kebab doesn't also select the
 * session.
 */
export function SessionActionsMenu({ sessionId, label, onRemoved }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setError(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setError(null);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="wd-web-row-menu" ref={rootRef}>
      <button
        type="button"
        className="wd-web-task-action"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="Session actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>
      {open && !confirm && (
        <div className="wd-web-menu" role="menu">
          <button
            role="menuitem"
            className="wd-web-menu-item"
            disabled={busy !== null}
            onClick={(e) => {
              e.stopPropagation();
              run('sync', () => syncWorktree(sessionId));
            }}
          >
            {busy === 'sync' ? 'Syncing…' : 'Sync (fetch + pull)'}
          </button>
          <button
            role="menuitem"
            className="wd-web-menu-item"
            disabled={busy !== null}
            onClick={(e) => {
              e.stopPropagation();
              run('rebase', () => rebaseWorktree(sessionId));
            }}
          >
            {busy === 'rebase' ? 'Rebasing…' : 'Rebase on parent'}
          </button>
          <button
            role="menuitem"
            className="wd-web-menu-item"
            disabled={busy !== null}
            onClick={(e) => {
              e.stopPropagation();
              run('editor', () => openInEditor(sessionId));
            }}
          >
            {busy === 'editor' ? 'Opening…' : 'Open in VS Code'}
          </button>
          <hr className="wd-web-menu-sep" />
          <button
            role="menuitem"
            className="wd-web-menu-item wd-web-menu-item-danger"
            onClick={(e) => {
              e.stopPropagation();
              setConfirm(true);
            }}
          >
            Remove worktree…
          </button>
          {error && <p className="wd-web-menu-error">{error}</p>}
        </div>
      )}
      {open && confirm && (
        <div className="wd-web-menu wd-web-menu-confirm" role="dialog">
          <p className="wd-web-menu-confirm-text">
            Remove worktree <code>{label}</code>?
          </p>
          <label className="wd-web-menu-confirm-force">
            <input
              type="checkbox"
              checked={force}
              onChange={(e) => setForce(e.target.checked)}
            />
            <span>force (discard uncommitted changes)</span>
          </label>
          {error && <p className="wd-web-menu-error">{error}</p>}
          <div className="wd-web-menu-confirm-actions">
            <button
              type="button"
              className="wd-btn-secondary"
              onClick={(e) => {
                e.stopPropagation();
                setConfirm(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="wd-btn-primary wd-btn-danger"
              disabled={busy !== null}
              onClick={(e) => {
                e.stopPropagation();
                run('remove', async () => {
                  await removeWorktree(sessionId, force);
                  onRemoved?.();
                });
              }}
            >
              {busy === 'remove' ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
