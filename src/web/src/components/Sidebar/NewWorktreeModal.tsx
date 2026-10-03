import { useEffect, useMemo, useRef, useState } from 'react';
import { ProjectPicker } from './ProjectPicker.js';
import { createWorktree, fetchProjects, type ProjectSummary } from '../../api/panes.js';

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
 * Modal for creating a worktree. Loads the list of configured projects
 * on mount, falls back to a free-text target if the list fails. Branch
 * is required; base is optional (server auto-resolves when blank).
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
  const [branch, setBranch] = useState(initial?.branch ?? '');
  const [base, setBase] = useState(initial?.base ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [name, setName] = useState('');
  // Created, but Claude didn't start: say so here, then let them go on.
  const [createdNoStart, setCreatedNoStart] = useState<{ id: string; reason: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFocusRef = useRef<HTMLSelectElement | HTMLInputElement | null>(null);

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
      setError(`${target} is a group: give it a branch (a group has no one checkout to open).`);
      return;
    }
    if (!branch.trim() && base.trim()) {
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
            <span>Branch {isGroup ? '' : '(optional)'}</span>
            <input
              ref={(el) => {
                if (initial?.target && !initial.branch) firstFocusRef.current = el;
              }}
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder={isGroup ? 'feat/whatever' : 'feat/whatever, or empty: its current branch'}
              disabled={submitting}
              required={isGroup}
            />
          </label>
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
            <span>Base (optional)</span>
            <input
              ref={(el) => {
                // Fallback focus target when both target AND branch are
                // prefilled (PR / Jira flows). Without this branch the
                // ref stays null and `null?.focus()` is a silent no-op,
                // leaving the modal with no keyboard focus.
                if (initial?.target && initial.branch) firstFocusRef.current = el;
              }}
              type="text"
              value={base}
              onChange={(e) => setBase(e.target.value)}
              placeholder="leave blank to use default"
              disabled={submitting}
            />
          </label>
          <label className="wd-modal-row">
            <span>Start Claude with (optional)</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Leave empty to create the worktree only"
              rows={prompt ? 6 : 2}
              disabled={submitting}
            />
          </label>
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
              {submitting ? 'Creating…' : prompt.trim() ? 'Create & start' : 'Create'}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}
