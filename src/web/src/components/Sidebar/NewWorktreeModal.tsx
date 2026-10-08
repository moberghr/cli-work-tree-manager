import { useEffect, useMemo, useRef, useState } from 'react';
import { ProjectPicker } from './ProjectPicker.js';
import { createWorktree, fetchBranchCheck, fetchProjects, lookupPr, type ProjectSummary } from '../../api/panes.js';
import type { BranchCheck } from '../../../../core/api-types.js';
import { suggestBranch } from '../../state/branch-suggest.js';
import { parsePrRef, workOnPrPrompt, type PrToStart } from '../../../../core/pr/pr-ref.js';

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
  /** The Repos page, for a project that isn't in the list yet. */
  onManageRepos?: () => void;
  /** Test seam; defaults to GET /api/branch-check. */
  checkBranch?: (target: string, branch: string) => Promise<BranchCheck>;
  /** Test seam; defaults to GET /api/pr-start. */
  findPr?: (ref: string, target?: string) => Promise<PrToStart>;
}

/** What a branch check means for what you're about to create; null when it's simply new. Pure. */
export function branchNote(check: BranchCheck, suggested: boolean): { text: string; blocks?: boolean } | null {
  if (!check.valid) return { text: `${check.branch} isn't a branch name git takes.`, blocks: true };
  if (suggested) {
    // A suggestion is swapped for a free name (the dialog shows that one); say why.
    if (check.free && check.free !== check.branch) return { text: `${check.branch} is taken, so a new one: ${check.free}.` };
    if (!check.free) return { text: `${check.branch} and its -2 … -9 are all taken: Edit to name the branch.`, blocks: true };
    return null;
  }
  if (check.session?.archived) return { text: `${check.branch} is an archived session: Create restores it and gives it the prompt.` };
  if (check.session) return { text: `${check.branch} already has a session: Create opens it and gives it the prompt.` };
  if (check.exists) return { text: `${check.branch} exists: Create checks it out, with the commits it has.` };
  return null;
}

/** "More options" with what's set in it, so a value folded away is never a surprise. Pure. */
export function moreLabel(name: string, base: string): string {
  const set = [name.trim() ? `name “${name.trim()}”` : '', base.trim() ? `base ${base.trim()}` : ''].filter(Boolean);
  return set.length ? `More options: ${set.join(' · ')}` : 'More options: name, base branch';
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
export function NewWorktreeModal({
  initial,
  title = 'New worktree',
  onCreated,
  onClose,
  onManageRepos,
  checkBranch = fetchBranchCheck,
  findPr = lookupPr,
}: Props) {
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
  // Starting on someone's PR: its link or number, looked up (gh pr view), then
  // its repo, branch and first prompt filled in — on their branch, pushes land in their PR.
  const [prOpen, setPrOpen] = useState(false);
  const [prRef, setPrRef] = useState('');
  const [prLooking, setPrLooking] = useState(false);
  const [prError, setPrError] = useState<string | null>(null);
  const [fromPr, setFromPr] = useState<PrToStart | null>(null);
  const lookUpPr = () => {
    if (!prRef.trim() || prLooking) return;
    setPrLooking(true);
    setPrError(null);
    // A link names its repo (the project follows it); a bare number is the picked project's.
    const ref = prRef.trim();
    findPr(ref, parsePrRef(ref)?.repo ? undefined : target.trim() || undefined).then(
      (pr) => {
        setFromPr(pr);
        setTarget(pr.alias);
        setBranchTyped(pr.branch);
        setBase('');
        setPrompt(workOnPrPrompt(pr));
        setPrOpen(false);
        setPrLooking(false);
      },
      (e: Error) => {
        setPrError(e.message);
        setPrLooking(false);
      },
    );
  };
  const suggestion = suggestBranch(prompt);
  const suggested = branchTyped === null;
  const wanted = branchTyped ?? suggestion;
  // Is the branch new for this project? Asked as you type (a pause), and again right before creating.
  const [check, setCheck] = useState<(BranchCheck & { target: string }) | null>(null);
  const checkFor = check && check.target === target.trim() && check.branch === wanted.trim() ? check : null;
  // A suggestion that's taken gives way to a free name: new work never lands on an old branch unasked.
  const branch = suggested && checkFor?.free ? checkFor.free : wanted;
  const note = checkFor ? branchNote(checkFor, suggested) : null;
  const setBranch = (b: string) => setBranchTyped(b);
  const checkRef = useRef(checkBranch);
  checkRef.current = checkBranch;
  useEffect(() => {
    const t = target.trim();
    const b = wanted.trim();
    if (!t || !b) return;
    let live = true;
    const timer = setTimeout(() => {
      checkRef.current(t, b).then(
        (r) => live && setCheck({ ...r, target: t }),
        () => {
          /* no answer: create as asked; the server still resolves the branch */
        },
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [target, wanted]);
  const formRef = useRef<HTMLFormElement>(null);
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
      setMore(true);
      setError('A base needs a branch to fork. Leave both empty to open the project as it is.');
      return;
    }
    if (note?.blocks) {
      setEditingBranch(true);
      setError(note.text);
      return;
    }
    setSubmitting(true);
    setError(null);
    // A suggestion not checked yet (created within the pause): ask now, so it can't land on a taken branch.
    let finalBranch = branch.trim();
    if (suggested && finalBranch && !checkFor) {
      const r = await checkBranch(target.trim(), finalBranch).catch(() => null);
      if (r?.free) finalBranch = r.free;
    }
    try {
      const res = await createWorktree({
        target: target.trim(),
        branch: finalBranch,
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
      <form className="wd-modal" onSubmit={submit} ref={formRef}>
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
              disabled={submitting || prLooking}
              inputRef={(el) => {
                if (!initial?.target) firstFocusRef.current = el;
              }}
            />
          </label>
          {onManageRepos && (
            <button type="button" className="wd-link-button wd-modal-aside" onClick={onManageRepos}>
              Not in the list? Repos & groups…
            </button>
          )}
          {fromPr && fromPr.alias === target && fromPr.branch === branch ? (
            <p className="wd-modal-pr" role="status">
              PR #{fromPr.number} by @{fromPr.author || 'its author'}: {fromPr.title}. On their branch <code>{fromPr.branch}</code>: what
              you push lands in their PR.
            </p>
          ) : prOpen ? (
            <label className="wd-modal-row">
              <span>Pull request: its link, or # in the project above</span>
              <span className="wd-modal-pr-row">
                <input
                  autoFocus
                  type="text"
                  value={prRef}
                  onChange={(e) => setPrRef(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      lookUpPr();
                    }
                  }}
                  placeholder="https://github.com/owner/repo/pull/123, or #123"
                  disabled={submitting || prLooking}
                />
                <button type="button" className="wd-btn-secondary" onClick={lookUpPr} disabled={submitting || prLooking || !prRef.trim()}>
                  {prLooking ? 'Looking…' : 'Use it'}
                </button>
              </span>
              {prError && (
                <span className="wd-modal-error" role="alert">
                  {prError}
                </span>
              )}
            </label>
          ) : (
            <button type="button" className="wd-link-button wd-modal-aside" onClick={() => setPrOpen(true)} disabled={submitting}>
              Start from a pull request…
            </button>
          )}
          <label className="wd-modal-row">
            <span>What should Claude do?</span>
            <textarea
              ref={(el) => {
                if (initial?.target) firstFocusRef.current = el;
              }}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                // Enter is a new line here; Ctrl+Enter (⌘+Enter) creates.
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              placeholder="Add CSV export to the invoices endpoint"
              rows={prompt.split('\n').length > 3 ? 8 : 4}
              disabled={submitting || prLooking}
            />
            <span className="wd-modal-hint">Leave it empty to just make the worktree. Ctrl+Enter creates.</span>
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
          {note && (
            <p className={'wd-modal-branch-note' + (note.blocks ? ' wd-modal-branch-note-bad' : '')} role="status">
              {note.text}
            </p>
          )}
          <button type="button" className="wd-link-button wd-modal-more" aria-expanded={more} onClick={() => setMore((m) => !m)}>
            {more ? '▾' : '▸'} {more ? 'More options: name, base branch' : moreLabel(name, base)}
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
              disabled={submitting || !target.trim() || !!note?.blocks}
            >
              {submitting ? 'Creating…' : prompt.trim() ? 'Create and start' : 'Create'}
            </button>
          )}
        </footer>
      </form>
    </div>
  );
}
