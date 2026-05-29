import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSessionDiff,
  type SessionDiff,
  type SessionSummary,
} from '../../api/client.js';
import { useSse } from '../../api/events.js';
import { DiffRepo } from './DiffRepo.js';

interface Props {
  session: SessionSummary;
}

export function DiffView({ session }: Props) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setError(null);
    fetchSessionDiff(session.id).then(
      (data) => {
        if (myReq !== reqIdRef.current) return;
        setDiff(data);
      },
      (err: Error) => {
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
      },
    );
  }, [session.id, reloadKey]);

  useSse(`/events?session=${encodeURIComponent(session.id)}`, {
    events: {
      'diff-changed': () => setReloadKey((n) => n + 1),
    },
  });

  // Active tab when the session has multiple repos (group). Default: first.
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  useEffect(() => {
    if (!diff || diff.repos.length === 0) return;
    if (!diff.repos.some((r) => r.name === activeRepoName)) {
      setActiveRepoName(diff.repos[0].name);
    }
  }, [diff, activeRepoName]);

  // Anchors stay stable across repos by prefixing with a running index.
  const repoStartIndex = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    if (diff) {
      for (const r of diff.repos) {
        map.set(r.name, i);
        i += r.files.length;
      }
    }
    return map;
  }, [diff]);

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!diff) return <div className="wd-web-empty">Loading diff…</div>;

  const totalFiles = diff.repos.reduce((s, r) => s + r.files.length, 0);
  if (totalFiles === 0) {
    return (
      <div className="wd-web-empty">
        No uncommitted changes in <code>{session.target}</code> ·{' '}
        <code>{session.branch}</code>.
      </div>
    );
  }

  const activeRepo =
    diff.repos.find((r) => r.name === activeRepoName) ?? diff.repos[0];
  const hasTabs = diff.repos.length > 1;

  return (
    <div className="wd-web-diff">
      <header className="wd-web-diff-header">
        <h2>
          {session.target}
          <span className="wd-web-branch"> · {session.branch}</span>
        </h2>
        <p className="wd-web-muted">
          {totalFiles} file{totalFiles === 1 ? '' : 's'} changed
          {hasTabs ? ` across ${diff.repos.length} repos` : ''}
        </p>
      </header>
      {hasTabs && (
        <nav className="wd-web-repo-tabs">
          {diff.repos.map((r) => {
            const add = r.files.reduce((s, f) => s + f.added, 0);
            const del = r.files.reduce((s, f) => s + f.deleted, 0);
            return (
              <button
                key={r.name}
                type="button"
                className={
                  'wd-web-repo-tab' +
                  (r.name === activeRepo.name ? ' wd-web-repo-tab-active' : '')
                }
                onClick={() => setActiveRepoName(r.name)}
              >
                {r.name}{' '}
                <span className="wd-web-tab-count">({r.files.length})</span>{' '}
                <span className="wd-tab-stats">
                  <span className="wd-add">+{add}</span>{' '}
                  <span className="wd-del">-{del}</span>
                </span>
              </button>
            );
          })}
        </nav>
      )}
      <DiffRepo
        repo={activeRepo}
        startIndex={repoStartIndex.get(activeRepo.name) ?? 0}
      />
    </div>
  );
}
