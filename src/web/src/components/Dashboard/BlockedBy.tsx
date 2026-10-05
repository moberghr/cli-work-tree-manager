import { useEffect, useRef, useState } from 'react';
import { addBlocker, removeBlocker, type SessionSummary } from '../../api/client.js';
import { prUrl } from '../../../../core/rail/blocks.js';

/**
 * In the session strip: what this session waits on (core/session-blocks.ts) —
 * "⛔ Waiting on feat/y · api#12", each with × to stop waiting on it. A
 * session it waits on opens on click. It clears by itself when they're done.
 */
export function BlockedByChip({ session, onOpen }: { session: SessionSummary; onOpen?: (id: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const list = session.blockedBy ?? [];
  if (list.length === 0) return null;
  const drop = (key: string) => {
    setError(null);
    removeBlocker(session.id, key).catch((err: Error) => setError(err.message));
  };
  return (
    <span className="wd-blocked" title="Out of the Inbox until these are done (merged, closed or archived); its Claude is told then">
      <span aria-hidden>⛔</span> Waiting on{' '}
      {list.map((b, i) => (
        <span key={b.key} className="wd-blocked-item">
          {i > 0 && ', '}
          {b.kind === 'session' && onOpen && b.sessionId ? (
            <button type="button" className="wd-overlap-link" onClick={() => onOpen(b.sessionId!)}>
              {b.label}
            </button>
          ) : b.url ? (
            <a href={b.url} target="_blank" rel="noreferrer" className="wd-overlap-link">
              {b.label}
            </a>
          ) : (
            <span>{b.label}</span>
          )}
          <button
            type="button"
            className="wd-blocked-drop"
            onClick={() => drop(b.key)}
            aria-label={`Stop waiting on ${b.label}`}
            title="Stop waiting on it"
          >
            ×
          </button>
        </span>
      ))}
      {error && <span className="wd-tab-error"> ⚠ {error}</span>}
    </span>
  );
}

/**
 * "Blocked by…": pick the session it waits on, or paste a pull request's URL.
 * Only live sessions other than this one; a URL must be a GitHub PR.
 */
export function BlockedByDialog({
  session,
  sessions,
  onDone,
  onClose,
}: {
  session: SessionSummary;
  sessions: SessionSummary[];
  onDone: (text: string) => void;
  onClose: () => void;
}) {
  const others = sessions.filter(
    (s) => s.id !== session.id && !s.archivedAt && !(session.blockedBy ?? []).some((b) => b.sessionId === s.id),
  );
  const [pick, setPick] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLSelectElement>(null);
  useEffect(() => first.current?.focus(), []);
  const pr = url.trim() ? prUrl(url) : null;
  const ready = !!pick || !!pr;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (pick) await addBlocker(session.id, { kind: 'session', id: pick });
      if (pr) await addBlocker(session.id, { kind: 'pr', url: pr.url });
      onDone([pick ? sessions.find((s) => s.id === pick)?.branch : null, pr?.label].filter(Boolean).join(' and '));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <div
      className="wd-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Blocked by"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        className="wd-modal"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => e.key === 'Escape' && !busy && onClose()}
      >
        <header className="wd-modal-header">
          <h2>{session.title && session.titleIsYours ? session.title : session.branch} is waiting on…</h2>
          <button type="button" className="wd-modal-close" onClick={onClose} aria-label="Close" disabled={busy}>
            ×
          </button>
        </header>
        <div className="wd-modal-body">
          <p className="wd-fork-note">
            It leaves the Inbox until that is done — the session archived (merged), the PR merged or closed — and then you and its Claude
            are told. A question from its Claude still shows.
          </p>
          <label className="wd-modal-row">
            <span>Another session</span>
            <select ref={first} value={pick} onChange={(e) => setPick(e.target.value)} disabled={busy}>
              <option value="">—</option>
              {others.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.target} · {s.title && s.titleIsYours ? `${s.title} (${s.branch})` : s.branch}
                </option>
              ))}
            </select>
          </label>
          <label className="wd-modal-row">
            <span>…or a pull request</span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/org/repo/pull/12"
              disabled={busy}
            />
          </label>
          {url.trim() && !pr && <p className="wd-modal-error">Not a GitHub pull request URL.</p>}
          {error && (
            <p className="wd-modal-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="wd-modal-footer">
          <button type="button" className="wd-btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="wd-btn-primary" disabled={!ready || busy}>
            {busy ? 'Saving…' : 'Wait on it'}
          </button>
        </footer>
      </form>
    </div>
  );
}
