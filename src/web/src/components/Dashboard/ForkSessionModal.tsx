import { useEffect, useRef, useState } from 'react';
import { forkSession, type SessionSummary } from '../../api/client.js';

interface Props {
  session: SessionSummary;
  /** Every session, so the suggested branch is one that isn't taken. */
  sessions: SessionSummary[];
  /** The fork exists (its Claude may not have started: `startError`). */
  onForked: (sessionId: string, info: { summarized: boolean; startError?: string }) => void;
  onClose: () => void;
}

/** `feat/x` → `feat/x-2` (or -3, … when taken). Pure. */
export function suggestForkBranch(branch: string, taken: ReadonlySet<string>): string {
  const stem = branch.replace(/-\d+$/, '');
  for (let n = 2; n < 100; n++) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
  return `${stem}-fork`;
}

/**
 * Fork a session (core/fork.ts): a new branch and worktree from where this
 * one's branch is, its Claude started with a summary of this conversation
 * and what you'd like it to try. Writing the summary takes a while, so the
 * dialog says what it's doing until the fork exists.
 */
export function ForkSessionModal({ session, sessions, onForked, onClose }: Props) {
  const [branch, setBranch] = useState(() =>
    suggestForkBranch(session.branch, new Set(sessions.filter((s) => s.target === session.target).map((s) => s.branch))),
  );
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    branchRef.current?.focus();
    branchRef.current?.select();
  }, []);
  const close = () => !busy && onClose();
  const uncommitted = session.diffStat?.files ?? 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !branch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await forkSession(session.id, { branch: branch.trim(), prompt: prompt.trim() || undefined, name: name.trim() || undefined });
      onForked(r.sessionId, { summarized: r.summarized, ...(r.startError ? { startError: r.startError } : {}) });
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
      aria-label={`Fork ${session.branch}`}
      onClick={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => e.key === 'Escape' && close()}
    >
      <form className="wd-modal" onSubmit={submit}>
        <header className="wd-modal-header">
          <h2>Fork {session.title && session.titleIsYours ? session.title : session.branch}</h2>
          <button type="button" className="wd-modal-close" onClick={close} aria-label="Close" disabled={busy}>
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <p className="wd-fork-note">
            A new worktree from <code>{session.branch}</code>&apos;s last commit{session.isGroup ? ', in each repo' : ''}
            {uncommitted ? ` — its ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} stay here` : ''}. Its Claude starts with a summary of this
            conversation; this session carries on as it is.
          </p>
          <label className="wd-modal-row">
            <span>New branch</span>
            <input ref={branchRef} type="text" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={busy} required />
          </label>
          <label className="wd-modal-row">
            <span>Name (optional)</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="shown instead of the branch, e.g. Try the queue approach"
              maxLength={120}
              disabled={busy}
            />
          </label>
          <label className="wd-modal-row">
            <span>What to try (optional)</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Empty: it reads the summary and waits for you"
              rows={prompt ? 5 : 2}
              disabled={busy}
            />
          </label>
          {busy && (
            <p className="wd-fork-busy" role="status">
              <span className="wd-spinner" aria-hidden="true" /> Creating the worktree and writing a summary of the conversation…
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
          <button type="submit" className="wd-btn-primary" disabled={busy || !branch.trim()}>
            {busy ? 'Forking…' : 'Fork'}
          </button>
        </footer>
      </form>
    </div>
  );
}
