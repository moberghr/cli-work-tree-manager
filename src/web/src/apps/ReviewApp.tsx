import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchScopeDiff,
  type RepoData,
  type ReviewContext,
} from '../api/client.js';
import { useSse } from '../api/events.js';
import { DiffRepo } from '../components/Diff/DiffRepo.js';
import { ReviewProvider } from '../state/ReviewProvider.js';
import { PendingPill } from '../components/Review/PendingPill.js';
import { EndReviewButton } from '../components/Review/EndReviewButton.js';

interface Props {
  context: ReviewContext;
}

/**
 * Single-scope review view. Mirrors what `wd -c` used to render server-side,
 * now driven by /api/diff with live updates pushed via diff-changed SSE.
 *
 * Comment UI (composer, drafts, submit, etc.) is added in a follow-up batch;
 * this first cut just renders the diff so we can verify the round-trip.
 */
export function ReviewApp({ context }: Props) {
  const [repos, setRepos] = useState<RepoData[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setError(null);
    fetchScopeDiff().then(
      (data) => {
        if (myReq !== reqIdRef.current) return;
        setRepos(data.repos);
      },
      (err: Error) => {
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
      },
    );
  }, [reloadKey]);

  useSse('/events', {
    events: {
      'diff-changed': () => setReloadKey((n) => n + 1),
      'comments-changed': () => {
        /* will refetch comments here once the comment layer lands */
      },
    },
  });

  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  useEffect(() => {
    if (!repos || repos.length === 0) return;
    if (!repos.some((r) => r.name === activeRepoName)) {
      setActiveRepoName(repos[0].name);
    }
  }, [repos, activeRepoName]);

  const repoStartIndex = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    if (repos) {
      for (const r of repos) {
        map.set(r.name, i);
        i += r.files.length;
      }
    }
    return map;
  }, [repos]);

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!repos) return <div className="wd-web-empty">Loading diff…</div>;

  const totalFiles = repos.reduce((s, r) => s + r.files.length, 0);
  if (totalFiles === 0) {
    return (
      <div className="wd-web-empty">
        No uncommitted changes in <code>{context.scopeLabel}</code>.
      </div>
    );
  }

  const activeRepo = repos.find((r) => r.name === activeRepoName) ?? repos[0];
  const hasTabs = repos.length > 1;

  return (
    <ReviewProvider>
      <div className="wd-web-main wd-web-review">
        <div className="wd-web-diff">
          <header className="wd-web-diff-header">
            <h2>{context.scopeLabel}</h2>
            <p className="wd-web-muted">
              {totalFiles} file{totalFiles === 1 ? '' : 's'} changed
              {hasTabs ? ` across ${repos.length} repos` : ''}
            </p>
          </header>
          {hasTabs && (
            <nav className="wd-web-repo-tabs">
              {repos.map((r) => {
                const add = r.files.reduce((s, f) => s + f.added, 0);
                const del = r.files.reduce((s, f) => s + f.deleted, 0);
                return (
                  <button
                    key={r.name}
                    type="button"
                    className={
                      'wd-web-repo-tab' +
                      (r.name === activeRepo.name
                        ? ' wd-web-repo-tab-active'
                        : '')
                    }
                    onClick={() => setActiveRepoName(r.name)}
                  >
                    {r.name}{' '}
                    <span className="wd-web-tab-count">
                      ({r.files.length})
                    </span>{' '}
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
            review
          />
        </div>
        <PendingPill />
        <EndReviewButton />
      </div>
    </ReviewProvider>
  );
}
