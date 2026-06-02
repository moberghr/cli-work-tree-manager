import { useEffect, useState } from 'react';
import { fetchPrs, type PrInfo } from '../../api/panes.js';
import { useSse } from '../../api/events.js';

interface Props {
  /** Called when the user picks a PR — caller opens the new-worktree
   *  modal pre-filled with this PR's target+branch. */
  onPick: (pr: PrInfo) => void;
}

/**
 * Collapsible PRs pane. Mirrors the dash UI: per-repo grouping, status
 * badges (✓/✗/●), draft / personal review / ownership markers. The
 * server caches nothing — every refresh shells out to `gh pr list` —
 * so we refetch lazily on open and on a 60s tick rather than per
 * sessions-changed event.
 */
export function PrsPane({ onPick }: Props) {
  const [prs, setPrs] = useState<PrInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [open, setOpen] = useState(false);

  function refresh() {
    fetchPrs().then(
      (r) => {
        setPrs(r.prs);
        if (r.available === false) setAvailable(false);
        if (r.error) setError(r.error);
        else setError(null);
      },
      (err: Error) => setError(err.message),
    );
  }

  // Refetch lazily — on first open and every 60s while open.
  useEffect(() => {
    if (!open) return;
    if (prs === null) refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [open, prs]);

  // Sessions-changed often coincides with branch state changes (push,
  // merge); piggyback on that broadcast for cheap-ish refreshes.
  useSse('/events', { events: { 'sessions-changed': () => open && refresh() } });

  return (
    <details
      className="wd-web-group wd-web-pane"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="wd-web-group-summary">
        <span className="wd-web-group-target">PRs</span>
        <span className="wd-web-group-count">{prs?.length ?? '…'}</span>
      </summary>
      {!available && (
        <p className="wd-web-empty-list">
          `gh` not available or not authenticated.
        </p>
      )}
      {available && prs && prs.length === 0 && !error && (
        <p className="wd-web-empty-list">No open PRs.</p>
      )}
      {error && <p className="wd-web-empty-list wd-web-error">{error}</p>}
      <ul className="wd-web-session-list">
        {prs?.map((pr) => (
          <li
            key={`${pr.repoAlias}#${pr.number}`}
            className="wd-web-session-row"
            onClick={() => onPick(pr)}
            title={pr.url}
          >
            <div className="wd-web-session-row-main">
              <PrStatusDots pr={pr} />
              <span className="wd-web-session-branch" title={pr.title}>
                {pr.title}
              </span>
            </div>
            <div className="wd-web-session-badges">
              <span className="wd-web-pr-meta">
                {pr.repoAlias} · #{pr.number}
              </span>
              <span className="wd-web-pr-meta wd-web-muted">{pr.branch}</span>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function PrStatusDots({ pr }: { pr: PrInfo }) {
  // ✓ green checks, ✗ red checks, ● pending checks, blank if no checks.
  const checks =
    pr.checksStatus === 'SUCCESS'
      ? { glyph: '✓', tone: 'ok', title: 'Checks passing' }
      : pr.checksStatus === 'FAILURE'
        ? { glyph: '✗', tone: 'fail', title: 'Checks failing' }
        : pr.checksStatus === 'PENDING'
          ? { glyph: '●', tone: 'pending', title: 'Checks pending' }
          : null;
  return (
    <span className="wd-web-pr-status" aria-hidden="true">
      {checks && (
        <span
          className={`wd-web-pr-check wd-web-pr-check-${checks.tone}`}
          title={checks.title}
        >
          {checks.glyph}
        </span>
      )}
      {pr.isDraft && (
        <span className="wd-web-pr-tag" title="Draft">
          D
        </span>
      )}
      {pr.isMine && (
        <span className="wd-web-pr-tag wd-web-pr-tag-mine" title="Your PR">
          ★
        </span>
      )}
      {pr.myReview === 'APPROVED' && (
        <span className="wd-web-pr-tag wd-web-pr-tag-ok" title="You approved">
          ✔
        </span>
      )}
      {pr.myReview === 'CHANGES_REQUESTED' && (
        <span
          className="wd-web-pr-tag wd-web-pr-tag-fail"
          title="You requested changes"
        >
          ✎
        </span>
      )}
    </span>
  );
}
