import { useEffect, useMemo, useRef, useState } from 'react';
import { ProjectPicker } from './ProjectPicker.js';
import { createWorktree, fetchProjects, type ProjectSummary } from '../../api/panes.js';
import { suggestBranch } from '../../state/branch-suggest.js';

interface Props {
  /** Pre-fill the modal (e.g. when opened from a PR or Jira issue). */
  initial?: {
    target?: string;
    branch?: string;
    base?: string;
    jiraKey?: string;
    /** First message for Claude (Jira / PR picks pre-fill one). */
    prompt?: string;
  };
  /** Title shown in the header. Defaults to "New worktree". */
  title?: string;
  /** Called with the new session id on successful create; `started` when
   *  Claude was started with the prompt (open its terminal). */
  onCreated: (sessionId: string, result?: { started?: 'started' | 'queued' }) => void;
  onClose: () => void;
}

/**
 * Modal for creating a worktree: a project and what Claude should do. The
 * branch is suggested from that (branch-suggest.ts; Edit to type your own),
 * and a name and a base branch are under "More options". Nothing for
 * Claude: just the worktree; no branch either: the project's own checkout.
 *
 * Reused by every "create worktree from X" flow — PRs (prefill target +
 * branch), Jira (prefill jiraKey + branch slug), Tasks (prefill branch
 * as `todo/<slug>`), and the standalone "+ New" button.
 */
export function NewWorktreeModal({ initial, title = 'New worktree', onCreated, onClose }: Props) {
  const [projects, setProjects] = useState<{
    singles: ProjectSummary[];
    groups: ProjectSummary[];
  } | null>(null);
  const [target, setTarget] = useState(initial?.target ?? '');
  // The branch follows what Claude should do until you edit it (or a pick named one).
  const [branchTyped, setBranchTyped] = useState<string | null>(initial?.branch ?? null);
  const [editingBranch, setEditingBranch] = useState(false);
  const [base, setBase] = useState(initial?.base ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [name, setName] = useState('');
  const [more, setMore] = useState(!!initial?.base);
  const branch = branchTyped ?? suggestBranch(prompt);
  const setBranch = (b: string) => setBranchTyped(b);
  // Created, but Claude didn't start: say so here, then let them go on.
  const [createdNoStart, setCreatedNoStart] = useState<{ id: string; reason: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFocusRef = useRef<HTMLSelectElement | HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    fetchProjects().then(
      (p) => {
        setProjects(p);
        // Default target to the first project if nothing prefilled.
        if (p.singles[0]) setTarget((t) => t || p.singles[0].name);
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
  const isGroup = !!projects?.groups.some((g) => g.name === target);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!target.trim()) {
      setError('Pick a project.');
      return;
    }
    // No branch: the project as it is, on its own checkout (`work tree <repo>`).
    if (!branch.trim() && isGroup) {
      setEditingBranch(true);
      setError(`${target} is a group: give it a branch (a group has no one checkout to open).`);
      return;
    }
    if (!branch.trim() && base.trim()) {
      setEditingBranch(true);
      setError('A base needs a branch to fork. Leave both empty to open the project as it is.');
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
        prompt: prompt.trim() || undefined,
        name: name.trim() || undefined,
      });
      if (res.startError) {
        setCreatedNoStart({ id: res.sessionId, reason: res.startError });
        setSubmitting(false);
        return;
      }
      onCreated(res.sessionId, { started: res.started });
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
          <button type="button" className="wd-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <label className="wd-modal-row">
            <span>Project</span>
            <ProjectPicker
              projects={targetOptions}
              value={target}
              onChange={setTarget}
              disabled={submitting}
              inputRef={(el) => {
                if (!initial?.target) firstFocusRef.current = el;
              }}
            />
          </label>
          <label className="wd-modal-row">
            <span>What should Claude do?</span>
            <textarea
              ref={(el) => {
                if (initial?.target) firstFocusRef.current = el;
              }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Add CSV export to the invoices endpoint"
              rows={prompt.split('\n').length > 3 ? 8 : 4}
              disabled={submitting}
            />
            <span className="wd-modal-hint">Leave it empty to just make the worktree.</span>
          </label>
          {editingBranch ? (
            <label className="wd-modal-row">
              <span>Branch {isGroup ? '' : '(empty: the project as it is)'}</span>
              <input
                autoFocus
                type="text"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={isGroup ? 'feat/whatever' : 'feat/whatever, or empty: its current branch'}
                disabled={submitting}
                required={isGroup}
              />
            </label>
          ) : (
            <div className="wd-modal-branch">
              Branch{' '}
              {branch ? (
                <code>{branch}</code>
              ) : (
                <span className="wd-modal-hint">{isGroup ? 'needed for a group' : 'none: the project as it is, on its own checkout'}</span>
              )}{' '}
              <button type="button" className="wd-link-button" onClick={() => setEditingBranch(true)} disabled={submitting}>
                Edit
              </button>
            </div>
          )}
          <button type="button" className="wd-link-button wd-modal-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            {more ? '▾' : '▸'} More options: name, base branch
          </button>
          {more && (
            <>
              <label className="wd-modal-row">
                <span>Name (optional)</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="shown instead of the branch, e.g. PDF generation speed"
                  maxLength={120}
                  disabled={submitting}
                />
              </label>
              <label className="wd-modal-row">
                <span>Base branch (optional)</span>
                <input
                  type="text"
                  value={base}
                  onChange={(e) => setBase(e.target.value)}
                  placeholder="leave blank to use the default"
                  disabled={submitting}
                />
              </label>
            </>
          )}
          {error && <p className="wd-modal-error">{error}</p>}
          {createdNoStart && (
            <p className="wd-modal-error" role="alert">
              The worktree was created, but Claude didn&apos;t start: {createdNoStart.reason}. Open the session and start it from its
              Terminal tab.
            </p>
          )}
        </div>
        <footer className="wd-modal-footer">
          <button type="button" className="wd-btn-secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          {createdNoStart ? (
            <button type="button" className="wd-btn-primary" onClick={() => onCreated(createdNoStart.id)}>
              Open session
            </button>
          ) : (
            <button
              type="submit"
              className="wd-btn-primary"
              // Only a project is needed: an empty branch opens a repo as it is,
              // and submit explains the cases that do need one (a group, a base).
              disabled={submitting || !target.trim()}
            >
              {submitting ? 'Creating…' : prompt.trim() ? 'Create and start' : 'Create'}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}
