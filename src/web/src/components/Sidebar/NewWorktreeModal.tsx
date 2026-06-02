import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createWorktree,
  fetchProjects,
  type ProjectSummary,
} from '../../api/panes.js';

interface Props {
  /** Pre-fill the modal (e.g. when opened from a PR or Jira issue). */
  initial?: {
    target?: string;
    branch?: string;
    base?: string;
    jiraKey?: string;
  };
  /** Title shown in the header. Defaults to "New worktree". */
  title?: string;
  /** Called with the new session id on successful create. */
  onCreated: (sessionId: string) => void;
  onClose: () => void;
}

/**
 * Modal for creating a worktree. Loads the list of configured projects
 * on mount, falls back to a free-text target if the list fails. Branch
 * is required; base is optional (server auto-resolves when blank).
 *
 * Reused by every "create worktree from X" flow — PRs (prefill target +
 * branch), Jira (prefill jiraKey + branch slug), Tasks (prefill branch
 * as `todo/<slug>`), and the standalone "+ New" button.
 */
export function NewWorktreeModal({
  initial,
  title = 'New worktree',
  onCreated,
  onClose,
}: Props) {
  const [projects, setProjects] = useState<{
    singles: ProjectSummary[];
    groups: ProjectSummary[];
  } | null>(null);
  const [target, setTarget] = useState(initial?.target ?? '');
  const [branch, setBranch] = useState(initial?.branch ?? '');
  const [base, setBase] = useState(initial?.base ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFocusRef = useRef<HTMLSelectElement | HTMLInputElement | null>(
    null,
  );

  useEffect(() => {
    fetchProjects().then(
      (p) => {
        setProjects(p);
        // Default target to the first project if nothing prefilled.
        if (!target && p.singles[0]) setTarget(p.singles[0].name);
      },
      () => setProjects({ singles: [], groups: [] }),
    );
  }, []);

  // Auto-focus the first non-prefilled field once projects are loaded.
  // The effect body runs after React commits the DOM for the freshly-
  // populated <select>, so firstFocusRef is guaranteed to point at the
  // real element. (The previous setTimeout(0) raced against the commit
  // and would focus a stale ref or nothing when fetchProjects was slow.)
  useEffect(() => {
    if (!projects) return;
    firstFocusRef.current?.focus();
  }, [projects]);

  const targetOptions = useMemo(() => {
    if (!projects) return [] as ProjectSummary[];
    return [...projects.groups, ...projects.singles];
  }, [projects]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!target.trim() || !branch.trim()) {
      setError('Target and branch are both required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await createWorktree({
        target: target.trim(),
        branch: branch.trim(),
        base: base.trim() || undefined,
        jiraKey: initial?.jiraKey,
      });
      onCreated(res.sessionId);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  function onBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div
      className="wd-modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={onBackdropClick}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <form className="wd-modal" onSubmit={submit}>
        <header className="wd-modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="wd-modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <label className="wd-modal-row">
            <span>Project</span>
            <select
              ref={(el) => {
                if (!initial?.target) firstFocusRef.current = el;
              }}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={submitting}
            >
              {targetOptions.length === 0 && (
                <option value="">(loading…)</option>
              )}
              {projects?.groups.map((g) => (
                <option key={'g:' + g.name} value={g.name}>
                  {g.name} (group)
                </option>
              ))}
              {projects?.singles.map((s) => (
                <option key={'s:' + s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="wd-modal-row">
            <span>Branch</span>
            <input
              ref={(el) => {
                if (initial?.target && !initial.branch)
                  firstFocusRef.current = el;
              }}
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="feat/whatever"
              disabled={submitting}
              required
            />
          </label>
          <label className="wd-modal-row">
            <span>Base (optional)</span>
            <input
              ref={(el) => {
                // Fallback focus target when both target AND branch are
                // prefilled (PR / Jira flows). Without this branch the
                // ref stays null and `null?.focus()` is a silent no-op,
                // leaving the modal with no keyboard focus.
                if (initial?.target && initial.branch)
                  firstFocusRef.current = el;
              }}
              type="text"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="leave blank to use default"
              disabled={submitting}
            />
          </label>
          {error && <p className="wd-modal-error">{error}</p>}
        </div>
        <footer className="wd-modal-footer">
          <button
            type="button"
            className="wd-btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="wd-btn-primary"
            disabled={submitting || !target || !branch}
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </footer>
      </form>
    </div>
  );
}
