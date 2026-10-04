import { useEffect, useRef, useState } from 'react';
import type { ReleaseNote } from '../../../../core/api-types.js';
import { fetchReleaseNotes } from '../../api/panes.js';
import { Markdown } from '../Markdown.js';

const date = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
};

/**
 * What's new: every release's notes, newest first (GitHub Releases, read by
 * work web), opened on `focus` when given — the version just installed.
 * Links open outside the dashboard.
 */
export function WhatsNew({
  focus,
  onClose,
  load = fetchReleaseNotes,
}: {
  focus?: string | null;
  onClose: () => void;
  load?: typeof fetchReleaseNotes;
}) {
  const [releases, setReleases] = useState<ReleaseNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    load().then(
      (r) => {
        setReleases(r.releases);
        if (!r.releases.length) setError(r.checkError ?? 'No release notes yet.');
      },
      (err: Error) => setError(err.message),
    );
  }, [load]);
  useEffect(() => {
    if (!focus || !releases) return;
    const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-version]') ?? [])].find((x) => x.dataset.version === focus);
    el?.scrollIntoView?.({ block: 'start' });
  }, [focus, releases]);

  return (
    <div
      className="wd-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="What's new"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="wd-modal wd-whats-new" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <header className="wd-modal-header">
          <h2>{focus ? `What's new in work ${focus}` : "What's new"}</h2>
          <button type="button" className="wd-modal-close" onClick={onClose} aria-label="Close" autoFocus>
            ×
          </button>
        </header>
        <div
          ref={listRef}
          className="wd-modal-body wd-whats-new-list"
          onClick={(e) => {
            // A link in the notes opens in the browser, not over the dashboard.
            const a = (e.target as HTMLElement).closest('a');
            if (!a?.href) return;
            e.preventDefault();
            window.open(a.href, '_blank', 'noopener');
          }}
        >
          {error && <p className="wd-start-note">{error}</p>}
          {!error && !releases && <p className="wd-start-note">Loading…</p>}
          {releases?.map((r) => (
            <section
              key={r.version}
              data-version={r.version}
              className={'wd-whats-new-release' + (r.version === focus ? ' wd-whats-new-focus' : '')}
            >
              <h3>
                {r.name} <span className="wd-tab-header-muted">{date(r.publishedAt)}</span>
              </h3>
              {r.body.trim() ? (
                <Markdown source={r.body} block className="wd-whats-new-body" />
              ) : (
                <p className="wd-start-note">No notes written.</p>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
