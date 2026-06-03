import { useEffect, useMemo, useState } from 'react';
import { fetchPrs, type PrInfo } from '../../../api/panes.js';
import { useSse } from '../../../api/events.js';

interface Props {
  onPick: (pr: PrInfo) => void;
}

type Scope = 'all' | 'mine' | 'needs-review';

/**
 * PRs as a sortable, filterable table — full-width version of the old
 * cramped sidebar accordion. Same data source (`/api/prs` → `gh pr list`
 * per configured repo), refreshed on open + every 60 s, plus an SSE
 * piggyback off `sessions-changed` (branch state often coincides).
 */
export function PrsTab({ onPick }: Props) {
  const [prs, setPrs] = useState<PrInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);
  const [scope, setScope] = useState<Scope>('all');

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

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, []);

  useSse('/events', {
    events: { 'sessions-changed': () => refresh() },
  });

  const filtered = useMemo(() => {
    if (!prs) return [];
    if (scope === 'mine') return prs.filter((p) => p.isMine);
    if (scope === 'needs-review') {
      return prs.filter(
        (p) => p.reviewDecision === 'REVIEW_REQUIRED' && !p.isMine,
      );
    }
    return prs;
  }, [prs, scope]);

  const byRepo = useMemo(() => {
    const m = new Map<string, PrInfo[]>();
    for (const p of filtered) {
      const arr = m.get(p.repoAlias) ?? [];
      arr.push(p);
      m.set(p.repoAlias, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <div className="wd-dash-tab-pane wd-tab-prs">
      <header className="wd-tab-header">
        <h1>
          PRs{' '}
          <span className="wd-tab-header-muted">
            ({filtered.length} {scope === 'all' ? 'open' : scope})
          </span>
        </h1>
        <div className="wd-tab-controls">
          <label>
            Scope{' '}
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as Scope)}
            >
              <option value="all">all</option>
              <option value="mine">mine</option>
              <option value="needs-review">needs review</option>
            </select>
          </label>
          <button
            type="button"
            className="wd-btn-secondary"
            onClick={refresh}
            title="Refresh"
          >
            ⟳
          </button>
        </div>
      </header>
      {!available && (
        <div className="wd-tab-empty">
          <code>gh</code> CLI not available or not authenticated. Install
          GitHub CLI and run <code>gh auth login</code>.
        </div>
      )}
      {error && <div className="wd-tab-empty wd-tab-error">{error}</div>}
      {available && !error && filtered.length === 0 && (
        <div className="wd-tab-empty">
          {prs === null ? 'Loading…' : `No PRs match "${scope}".`}
        </div>
      )}
      {byRepo.length > 0 && (
        <table className="wd-pr-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Repo · Branch</th>
              <th>Title</th>
              <th>Checks</th>
              <th>Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {byRepo.flatMap(([repo, list]) => [
              <tr key={`g:${repo}`} className="wd-pr-group">
                <td colSpan={6} className="wd-pr-group-label">
                  {repo}{' '}
                  <span className="wd-tab-header-muted">
                    ({list.length})
                  </span>
                </td>
              </tr>,
              ...list.map((pr) => (
                <tr
                  key={`${pr.repoAlias}#${pr.number}`}
                  className="wd-pr-row"
                  onClick={() => onPick(pr)}
                  title={pr.url}
                >
                  <td className="wd-pr-num">#{pr.number}</td>
                  <td className="wd-pr-branch">{pr.branch}</td>
                  <td className="wd-pr-title">
                    {pr.isDraft && (
                      <span className="wd-pr-badge wd-pr-badge-draft">DRAFT</span>
                    )}
                    {pr.title}
                  </td>
                  <td><ChecksCell pr={pr} /></td>
                  <td><ReviewCell pr={pr} /></td>
                  <td className="wd-pr-actions">
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title="Open on GitHub"
                    >
                      ↗
                    </a>
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ChecksCell({ pr }: { pr: PrInfo }) {
  if (pr.checksStatus === 'SUCCESS')
    return <span className="wd-pr-check wd-pr-check-ok" title="Passing">✓</span>;
  if (pr.checksStatus === 'FAILURE')
    return <span className="wd-pr-check wd-pr-check-fail" title="Failing">✗</span>;
  if (pr.checksStatus === 'PENDING')
    return <span className="wd-pr-check wd-pr-check-pending" title="Pending">●</span>;
  return <span className="wd-pr-check-none">—</span>;
}

function ReviewCell({ pr }: { pr: PrInfo }) {
  if (pr.isMine) return <span title="Your PR">★</span>;
  if (pr.myReview === 'APPROVED')
    return <span className="wd-pr-check-ok" title="You approved">✔</span>;
  if (pr.myReview === 'CHANGES_REQUESTED')
    return <span className="wd-pr-check-fail" title="Changes requested">✎</span>;
  if (pr.reviewDecision === 'APPROVED')
    return <span className="wd-pr-check-ok" title="Approved">✔</span>;
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    return <span className="wd-pr-check-fail" title="Changes requested">✎</span>;
  return <span className="wd-pr-check-none">—</span>;
}
