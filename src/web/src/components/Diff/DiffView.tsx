import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSessionDiff,
  type DiffBase,
  type RepoData,
  type SessionDiff,
  type SessionSummary,
} from '../../api/client.js';
import { sessionReviewApi } from '../../api/review-api.js';
import { useSse } from '../../api/events.js';
import { ReviewProvider } from '../../state/ReviewProvider.js';
import { DiffRepo } from './DiffRepo.js';
import { FileTree } from '../Sidebar/FileTree.js';
import { CommentsPanel } from '../Sidebar/CommentsPanel.js';
import { GeneralPane } from '../Review/GeneralPane.js';
import { PendingPill } from '../Review/PendingPill.js';
import { useViewedFiles } from '../../hooks/use-viewed-files.js';
import { useScrollspy } from '../../hooks/use-scrollspy.js';
import {
  ResizeDivider,
  useSidebarWidth,
} from '../Layout/ResizeDivider.js';

interface Props {
  session: SessionSummary;
}

/**
 * The single-session view inside `work web`. Shows a live diff plus the
 * full review UI (drafts/submit/comments) backed by per-session storage.
 *
 * All hooks must run unconditionally on every render — branching on
 * `diff === null` happens after the hooks.
 */
export function DiffView({ session }: Props) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reqIdRef = useRef(0);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  // Per-session diff scope. Defaults to uncommitted (the working-tree
  // view). 'branch' shows everything since this worktree was forked,
  // using the recorded baseBranch or auto-detected parent (main/master/
  // dev/develop).
  const [diffBase, setDiffBase] = useState<DiffBase>('uncommitted');

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setError(null);
    fetchSessionDiff(session.id, diffBase).then(
      (data) => {
        if (myReq !== reqIdRef.current) return;
        setDiff(data);
      },
      (err: Error) => {
        if (myReq !== reqIdRef.current) return;
        setError(err.message);
      },
    );
  }, [session.id, reloadKey, diffBase]);

  useSse(`/events?session=${encodeURIComponent(session.id)}`, {
    events: {
      'diff-changed': () => setReloadKey((n) => n + 1),
    },
  });

  const api = useMemo(() => sessionReviewApi(session.id), [session.id]);

  useEffect(() => {
    if (!diff || diff.repos.length === 0) return;
    if (!diff.repos.some((r) => r.name === activeRepoName)) {
      setActiveRepoName(diff.repos[0].name);
    }
  }, [diff, activeRepoName]);

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

  const activeRepo: RepoData | null = useMemo(() => {
    if (!diff || diff.repos.length === 0) return null;
    return diff.repos.find((r) => r.name === activeRepoName) ?? diff.repos[0];
  }, [diff, activeRepoName]);
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
    ? `session:${session.id}:${activeRepo.name}`
    : `session:${session.id}:_pending`;
  const { viewedPaths, viewedAnchors, toggle: toggleViewed } = useViewedFiles(
    scopeKey,
    pathToAnchor,
  );
  const activeAnchor = useScrollspy(
    `${session.id}:${activeRepo?.name ?? '_pending'}`,
  );
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();
  const layoutRef = useRef<HTMLDivElement>(null);

  // ---- Hooks above this line, branches below ----------------------------

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!diff) return <div className="wd-web-empty">Loading diff…</div>;

  const totalFiles = diff.repos.reduce((s, r) => s + r.files.length, 0);
  const isEmpty = totalFiles === 0 || !activeRepo;
  const hasTabs = diff.repos.length > 1;
  // Three flavours of empty depending on what scope failed:
  //   - uncommitted mode → working tree is clean.
  //   - branch mode, resolvedBase missing or HEAD → couldn't find a
  //     parent branch in our candidates (main, master, dev, develop, and
  //     their origin/* mirrors). The branch was created from something
  //     else (a feature branch off another feature branch, a tag, etc.).
  //   - branch mode, resolvedBase is a real branch → there genuinely
  //     are no commits past it. The branch is up to date or merged.
  let emptyMessage: string;
  if (diffBase === 'uncommitted') {
    emptyMessage = 'No uncommitted changes.';
  } else if (!diff.resolvedBase || diff.resolvedBase === 'HEAD') {
    emptyMessage =
      "Couldn't auto-detect this branch's parent. " +
      'Tried main, master, dev, develop (and their origin/* mirrors). ' +
      'Record an explicit base via `work tree --base <ref>` to fix.';
  } else {
    emptyMessage = `No commits since \`${diff.resolvedBase}\` — this branch is up to date or already merged.`;
  }

  return (
    <ReviewProvider api={api}>
      <div
        ref={layoutRef}
        className="wd-web-review-layout"
        style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
      >
        <aside className="wd-web-review-sidebar">
          <header className="wd-web-review-sidebar-header">
            <h1>
              {session.target}
              <span className="wd-web-branch"> · {session.branch}</span>
            </h1>
            <p>
              {isEmpty ? (
                <span className="wd-web-muted">no changes</span>
              ) : (
                <>
                  {totalFiles} file{totalFiles === 1 ? '' : 's'} changed
                  {hasTabs ? ` across ${diff.repos.length} repos` : ''}
                </>
              )}
              {diff.base === 'branch' && diff.resolvedBase && (
                <>
                  {' '}
                  <span className="wd-web-muted">vs {diff.resolvedBase}</span>
                </>
              )}
            </p>
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
                title="git diff HEAD — only the working-tree deltas"
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
                title={
                  session.baseBranch
                    ? `git diff ${session.baseBranch} — everything since this branch was created`
                    : "Everything since this worktree's parent branch — auto-detected"
                }
              >
                Since branch
              </button>
            </div>
          </header>
          {!isEmpty && activeRepo && (
            <>
              <FileTree
                files={activeRepo.files}
                startIndex={activeStart}
                selectedAnchor={activeAnchor}
                viewedAnchors={viewedAnchors}
              />
              <CommentsPanel repoName={activeRepo.name} />
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
          // Always set --tabs-offset (0px when no tabs) so the value is
          // present in every render. With keep-mounted-hidden dashboard
          // nav, an incoming pane that flips from hidden to visible would
          // otherwise paint one frame without the variable — single-frame
          // layout jump when scrolling sticky-positioned file headers.
          style={{ ['--tabs-offset' as string]: hasTabs ? '36px' : '0px' }}
        >
          {isEmpty || !activeRepo ? (
            <div className="wd-web-empty wd-web-empty-diff">
              <p>{emptyMessage}</p>
              {diffBase === 'uncommitted' && (
                <p className="wd-web-empty-hint">
                  Try <button
                    type="button"
                    className="wd-web-link-btn"
                    onClick={() => setDiffBase('branch')}
                  >Since branch</button> to see everything in this worktree.
                </p>
              )}
            </div>
          ) : (
            <>
              <GeneralPane />
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
                          (r.name === activeRepo.name
                            ? ' wd-web-repo-tab-active'
                            : '')
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
                startIndex={activeStart}
                review
                viewedPaths={viewedPaths}
                onToggleViewed={toggleViewed}
              />
            </>
          )}
        </main>
        {!isEmpty && <PendingPill />}
      </div>
    </ReviewProvider>
  );
}
