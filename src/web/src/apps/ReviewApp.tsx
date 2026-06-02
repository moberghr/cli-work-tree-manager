import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchScopeDiff,
  fetchScopeDiffByHash,
  staticHasBranchScope,
  type DiffBase,
  type RepoData,
  type ReviewContext,
} from '../api/client.js';
import { useSse } from '../api/events.js';
import { DiffRepo } from '../components/Diff/DiffRepo.js';
import { ReviewProvider } from '../state/ReviewProvider.js';
import { scopeHashReviewApi } from '../api/review-api.js';
import { PendingPill } from '../components/Review/PendingPill.js';
import { EndReviewButton } from '../components/Review/EndReviewButton.js';
import { GeneralPane } from '../components/Review/GeneralPane.js';
import { FileTree } from '../components/Sidebar/FileTree.js';
import { CommentsPanel } from '../components/Sidebar/CommentsPanel.js';
import { useViewedFiles } from '../hooks/use-viewed-files.js';
import { useScrollspy } from '../hooks/use-scrollspy.js';
import {
  ResizeDivider,
  useSidebarWidth,
} from '../components/Layout/ResizeDivider.js';

interface Props {
  context: ReviewContext;
  /** When set, the SPA is being viewed at /diff/<hash> or /review/<hash>
   *  served by `work web`. Diff data + review API route through
   *  `/api/scopes/<hash>/...` instead of the legacy `/api/diff` etc.
   *  Empty for the standalone-server case (`wd --server`, `wd -c`). */
  scopeHash?: string;
}

/**
 * Single-scope review view. All hooks live at the top so React's
 * rules-of-hooks invariant holds — every hook fires unconditionally on
 * every render. Branching on `repos === null` happens after the hooks.
 */
export function ReviewApp({ context, scopeHash }: Props) {
  const [repos, setRepos] = useState<RepoData[] | null>(null);
  const [resolvedBase, setResolvedBase] = useState<string | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reqIdRef = useRef(0);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  const readOnly = !!context.readOnly;
  // Per-view diff scope. Honors the server/CLI default; the user can
  // toggle in-browser. Tab visibility is gated by whether the branch
  // scope is actually available (CLI couldn't detect a parent → no
  // tab).
  const [diffBase, setDiffBase] = useState<DiffBase>(
    context.initialBase ?? 'uncommitted',
  );
  const hasBranchTab = context.staticMode
    ? staticHasBranchScope()
    : true; // server mode always supports both — server resolves on demand.

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setError(null);
    const fetcher = scopeHash
      ? fetchScopeDiffByHash(scopeHash, diffBase)
      : fetchScopeDiff(diffBase);
    fetcher.then(
      (data) => {
        if (myReq !== reqIdRef.current) return;
        setRepos(data.repos);
        setResolvedBase(data.resolvedBase);
      },
      (err: Error) => {
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
      },
    );
  }, [reloadKey, diffBase, scopeHash]);

  // In scope-mounted mode, listen to the scope-narrowed SSE stream — it
  // only fires for THIS scope's file changes. Standalone mode uses the
  // global /events stream (its diff server only handles one scope).
  useSse(
    scopeHash
      ? `/api/scopes/${encodeURIComponent(scopeHash)}/events`
      : '/events',
    {
      events: {
        'diff-changed': () => setReloadKey((n) => n + 1),
      },
    },
  );

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

  // Resolve the active repo (or a stable fallback). `activeRepo` is null
  // when there are no repos yet — the hooks below still run, they just
  // operate on empty inputs.
  const activeRepo: RepoData | null = useMemo(() => {
    if (!repos || repos.length === 0) return null;
    return repos.find((r) => r.name === activeRepoName) ?? repos[0];
  }, [repos, activeRepoName]);
  const activeStart = activeRepo
    ? (repoStartIndex.get(activeRepo.name) ?? 0)
    : 0;

  const pathToAnchor = useMemo(() => {
    const map = new Map<string, string>();
    if (!activeRepo) return map;
    activeRepo.files.forEach((f, i) => {
      map.set(f.path, `wd-file-${activeStart + i}`);
    });
    return map;
  }, [activeRepo, activeStart]);

  const scopeKey = activeRepo
    ? `scope:${context.scopeLabel}:${activeRepo.name}`
    : `scope:${context.scopeLabel}:_pending`;
  const hunkScopeKey = activeRepo
    ? `scope:${context.scopeLabel}:${activeRepo.name}:hunks`
    : '';
  const { viewedPaths, viewedAnchors, toggle: toggleViewed } = useViewedFiles(
    scopeKey,
    pathToAnchor,
  );
  const activeAnchor = useScrollspy(activeRepo?.name ?? '_pending');
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();
  const layoutRef = useRef<HTMLDivElement>(null);

  // ---- Hooks above this line, branches below ----------------------------

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!repos) return <div className="wd-web-empty">Loading diff…</div>;

  const totalFiles = repos.reduce((s, r) => s + r.files.length, 0);
  const isEmpty = totalFiles === 0 || !activeRepo;
  const hasTabs = repos.length > 1;
  // Empty-state copy mirrors DiffView's three-bucket diagnostic so the
  // user knows whether detection failed or the branch is just up to date.
  let emptyMessage: string;
  if (diffBase === 'uncommitted') {
    emptyMessage = 'No uncommitted changes.';
  } else if (!resolvedBase || resolvedBase === 'HEAD') {
    emptyMessage =
      "Couldn't auto-detect this branch's parent. " +
      'Tried main, master, dev, develop (and their origin/* mirrors).';
  } else {
    emptyMessage = `No commits since \`${resolvedBase}\` — branch is up to date or already merged.`;
  }

  // In read-only mode (static files, `wd`, `wd --server`) there's no
  // backing comment server — mounting ReviewProvider would trigger a
  // useless fetch('/api/comments') that 405s on a server and CORS-fails
  // over file://. The layout works fine without the provider; every
  // child that needs review state already calls useReviewOptional().
  const layout = (
    <div
      ref={layoutRef}
      className="wd-web-review-layout"
      style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
    >
        <aside className="wd-web-review-sidebar">
          <header className="wd-web-review-sidebar-header">
            <h1>{context.scopeLabel}</h1>
            <p>
              {isEmpty ? (
                <span className="wd-web-muted">no changes</span>
              ) : (
                <>
                  {totalFiles} file{totalFiles === 1 ? '' : 's'} changed
                  {hasTabs ? ` across ${repos.length} repos` : ''}
                </>
              )}
              {diffBase === 'branch' && resolvedBase && (
                <>
                  {' '}
                  <span className="wd-web-muted">vs {resolvedBase}</span>
                </>
              )}
            </p>
            {hasBranchTab && (
              <div
                className="wd-web-diff-scope"
                role="tablist"
                aria-label="Diff scope"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={diffBase === 'uncommitted'}
                  className={
                    'wd-web-diff-scope-btn' +
                    (diffBase === 'uncommitted'
                      ? ' wd-web-diff-scope-btn-active'
                      : '')
                  }
                  onClick={() => setDiffBase('uncommitted')}
                >
                  Uncommitted
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={diffBase === 'branch'}
                  className={
                    'wd-web-diff-scope-btn' +
                    (diffBase === 'branch'
                      ? ' wd-web-diff-scope-btn-active'
                      : '')
                  }
                  onClick={() => setDiffBase('branch')}
                >
                  Since branch
                </button>
              </div>
            )}
          </header>
          {!isEmpty && activeRepo && (
            <>
              <FileTree
                files={activeRepo.files}
                startIndex={activeStart}
                selectedAnchor={activeAnchor}
                viewedAnchors={viewedAnchors}
              />
              {!readOnly && <CommentsPanel repoName={activeRepo.name} />}
            </>
          )}
        </aside>
        <ResizeDivider
          layoutRef={layoutRef}
          width={sidebarWidth}
          onCommit={setSidebarWidth}
        />
        <main
          className="wd-web-review-main"
          // Always set --tabs-offset (0px when no tabs) — keeps the
          // sticky-header offset stable across tab switches in
          // keep-mounted-hidden layouts.
          style={{ ['--tabs-offset' as string]: hasTabs ? '36px' : '0px' }}
        >
          {isEmpty || !activeRepo ? (
            <div className="wd-web-empty wd-web-empty-diff">
              <p>{emptyMessage}</p>
              {diffBase === 'uncommitted' && hasBranchTab && (
                <p className="wd-web-empty-hint">
                  Try{' '}
                  <button
                    type="button"
                    className="wd-web-link-btn"
                    onClick={() => setDiffBase('branch')}
                  >
                    Since branch
                  </button>{' '}
                  to see everything in this worktree.
                </p>
              )}
            </div>
          ) : (
            <>
              {!readOnly && <GeneralPane />}
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
                startIndex={activeStart}
                review={!readOnly}
                viewedPaths={viewedPaths}
                onToggleViewed={toggleViewed}
                hunkScopeKey={hunkScopeKey}
              />
            </>
          )}
        </main>
        {!readOnly && !isEmpty && <PendingPill />}
        {!readOnly && !isEmpty && <EndReviewButton />}
    </div>
  );

  if (readOnly) return layout;
  // For scope-mounted review (`/review/<hash>`), point the provider at
  // the scope's comment endpoints. Standalone `wd -c` uses the default
  // scopeReviewApi which targets the bare `/api/comments`.
  const reviewApi = scopeHash ? scopeHashReviewApi(scopeHash) : undefined;
  return <ReviewProvider api={reviewApi}>{layout}</ReviewProvider>;
}
