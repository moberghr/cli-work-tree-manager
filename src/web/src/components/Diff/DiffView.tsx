import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchSessionCheckpoints,
  fetchSessionDiff,
  revertChange,
  turnsFrom,
  type CheckpointEntry,
  type DiffBase,
  type RepoData,
  type SessionSummary,
} from '../../api/client.js';
import { sessionReviewApi } from '../../api/review-api.js';
import { useSse } from '../../api/events.js';
import { useDeferredDiffLoad } from '../../hooks/use-deferred-diff-load.js';
import { ReviewProvider } from '../../state/ReviewProvider.js';
import { RevertContext, type RevertApi } from '../../state/RevertProvider.js';
import { DiffRepo } from './DiffRepo.js';
import { DiffBusyChip } from './DiffBusyChip.js';
import { DiffUpdateChip } from './DiffUpdateChip.js';
import { DiffModeToggle } from './DiffModeToggle.js';
import { FileTree } from '../Sidebar/FileTree.js';
import { CommentsPanel } from '../Sidebar/CommentsPanel.js';
import { GeneralPane } from '../Review/GeneralPane.js';
import { PendingPill } from '../Review/PendingPill.js';
import { useViewedFiles } from '../../hooks/use-viewed-files.js';
import { useCommentJump } from '../../hooks/use-comment-jump.js';
import { useFollowActiveInSidebar, useScrollspy } from '../../hooks/use-scrollspy.js';
import {
  COMMENTS_SPEC,
  ResizeDivider,
  useResizableSize,
  useSidebarWidth,
} from '../Layout/ResizeDivider.js';

interface Props {
  session: SessionSummary;
  /** Open on "Last turn" once the session's turns are known (the review
   *  queue, and finished sessions opened from the inbox). */
  startOnLastTurn?: boolean;
}

/**
 * The single-session view inside `work web`. Shows a live diff plus the
 * full review UI (drafts/submit/comments) backed by per-session storage.
 *
 * All hooks must run unconditionally on every render — branching on
 * `diff === null` happens after the hooks.
 */
export function DiffView({ session, startOnLastTurn = false }: Props) {
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  // Per-session diff scope. Defaults to uncommitted (the working-tree
  // view). 'branch' shows everything since this worktree was forked,
  // using the recorded baseBranch or auto-detected parent (main/master/
  // dev/develop).
  const [diffBase, setDiffBase] = useState<DiffBase>('uncommitted');
  // "Last turn" (Codex-style): the diff of one Claude instruction, between
  // two consecutive checkpoints. null = not in turn mode; otherwise the
  // `to` checkpoint id of the turn being shown.
  const [turnTo, setTurnTo] = useState<number | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const turns = useMemo(() => turnsFrom(checkpoints), [checkpoints]);
  const turn = turnTo === null ? null : (turns.find((t) => t.to === turnTo) ?? null);
  // A late answer for the previous session must not land on this one.
  const checkpointsFor = useRef(session.id);
  checkpointsFor.current = session.id;
  const loadCheckpoints = () => {
    const id = session.id;
    const apply = (entries: CheckpointEntry[]) => {
      if (checkpointsFor.current === id) setCheckpoints(entries);
    };
    fetchSessionCheckpoints(id).then(apply, () => apply([]));
  };
  useEffect(() => {
    setTurnTo(null);
    setCheckpoints([]);
    loadCheckpoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  // Once per session: jump to its newest turn as soon as the turns load.
  // Only once — after that the scope buttons are the user's.
  const lastTurnApplied = useRef<string | null>(null);
  useEffect(() => {
    if (!startOnLastTurn || lastTurnApplied.current === session.id || turns.length === 0) return;
    lastTurnApplied.current = session.id;
    setTurnTo(turns[0].to);
  }, [startOnLastTurn, session.id, turns]);

  // Shared fetch + deferred-loading hook (same one ReviewApp uses) so a
  // base switch here gets the spinner/dim feedback instead of the old
  // "frozen, then snaps" behaviour.
  const {
    data: diff,
    error,
    loading,
    checking,
    pending,
    stale,
    applyPending,
    reload,
    checkForUpdates,
  } = useDeferredDiffLoad(
    () =>
      turn
        ? fetchSessionDiff(session.id, 'uncommitted', { from: turn.from, to: turn.to })
        : fetchSessionDiff(session.id, diffBase),
    [session.id, diffBase, turn?.from, turn?.to],
  );

  useSse(`/events?session=${encodeURIComponent(session.id)}`, {
    events: {
      // Stage the new diff instead of swapping it in — a Claude turn writing
      // files must not re-render the diff under someone reading it. The
      // update banner hands control to the user.
      'diff-changed': () => checkForUpdates(),
      // A turn finished → a new checkpoint (and so a new "last turn").
      'checkpoints-changed': () => loadCheckpoints(),
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
  const hunkScopeKey = activeRepo
    ? `session:${session.id}:${activeRepo.name}:hunks`
    : '';
  const { viewedPaths, viewedAnchors, toggle: toggleViewed } = useViewedFiles(
    scopeKey,
    pathToAnchor,
  );
  const activeAnchor = useScrollspy(
    `${session.id}:${activeRepo?.name ?? '_pending'}`,
  );
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();
  const { size: commentsHeight, setSize: setCommentsHeight } =
    useResizableSize(COMMENTS_SPEC);
  const layoutRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  // The dashboard diff scrolls inside <main> (not the document), so "back to
  // the top" on reload has to move that element.
  const mainRef = useRef<HTMLElement>(null);
  useCommentJump(mainRef);

  // The "Reload" action: refetch from the server and return to the top —
  // a browser refresh's useful half, without tearing down the dashboard
  // (attached terminal, route, sidebar width all survive).
  const reloadFromTop = () => {
    reload();
    mainRef.current?.scrollTo({ top: 0 });
  };

  // The sidebar splits into file tree (top, own scroller) | drag handle |
  // comments panel (bottom, resizable height).
  const treeScrollRef = useRef<HTMLDivElement>(null);

  // The tree pane is always its own scroller, so the active row drifts
  // off-screen without this — always enabled here.
  useFollowActiveInSidebar(treeScrollRef, activeAnchor, true);

  // Revert is for the Uncommitted scope only: that's the diff against the
  // working tree it undoes. (A turn or the branch diff would mean undoing
  // committed or partial history.)
  const canRevert = !turn && diffBase === 'uncommitted';
  const revertApi = useMemo<RevertApi | null>(
    () =>
      canRevert
        ? {
            revert: async (repo, path, lines) => {
              await revertChange(session.id, { repo, path, lines });
              reload();
            },
          }
        : null,
    [canRevert, session.id, reload],
  );

  // ---- Hooks above this line, branches below ----------------------------

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!diff) return <div className="wd-web-empty">Loading diff…</div>;

  const totalFiles = diff.repos.reduce((s, r) => s + r.files.length, 0);
  // File count of the staged (not-yet-shown) diff, for the banner's summary.
  const pendingFileCount = pending
    ? pending.repos.reduce((s, r) => s + r.files.length, 0)
    : null;
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
  if (turn) {
    emptyMessage = 'This turn changed no files.';
  } else if (diffBase === 'uncommitted') {
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
     <RevertContext.Provider value={revertApi}>
      <div
        ref={layoutRef}
        className="wd-web-review-layout"
        style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}
      >
        <aside
          ref={sidebarRef}
          className="wd-web-review-sidebar wd-web-review-sidebar-split"
          style={{ [COMMENTS_SPEC.cssVar as string]: `${commentsHeight}px` }}
        >
          <header className="wd-web-review-sidebar-header">
            <h1>
              {session.target}
              <span className="wd-web-branch"> · {session.branch}</span>
            </h1>
            <p>
              {stale ? (
                <span className="wd-web-muted">loading…</span>
              ) : isEmpty ? (
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
                aria-selected={!turn && diffBase === 'uncommitted'}
                className={
                  'wd-web-diff-scope-btn' +
                  (!turn && diffBase === 'uncommitted'
                    ? ' wd-web-diff-scope-btn-active'
                    : '')
                }
                onClick={() => {
                  setTurnTo(null);
                  setDiffBase('uncommitted');
                }}
                title="git diff HEAD — only the working-tree deltas"
              >
                Uncommitted
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!turn && diffBase === 'branch'}
                className={
                  'wd-web-diff-scope-btn' +
                  (!turn && diffBase === 'branch'
                    ? ' wd-web-diff-scope-btn-active'
                    : '')
                }
                onClick={() => {
                  setTurnTo(null);
                  setDiffBase('branch');
                }}
                title={
                  session.baseBranch
                    ? `git diff ${session.baseBranch} — everything since this branch was created`
                    : "Everything since this worktree's parent branch — auto-detected"
                }
              >
                Since branch
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={!!turn}
                className={'wd-web-diff-scope-btn' + (turn ? ' wd-web-diff-scope-btn-active' : '')}
                disabled={turns.length === 0}
                onClick={() => setTurnTo(turns[0]?.to ?? null)}
                title={
                  turns.length
                    ? "Only what Claude's last instruction changed"
                    : 'No finished turn yet — appears after Claude finishes one'
                }
              >
                Last turn
              </button>
            </div>
            {turn && turns.length > 1 && (
              <label className="wd-web-turn-pick">
                <span className="wd-web-muted">Turn</span>{' '}
                <select
                  value={turn.to}
                  onChange={(e) => setTurnTo(Number(e.target.value))}
                  aria-label="Which turn"
                >
                  {turns.map((t) => (
                    <option key={t.to} value={t.to}>
                      {t.n}{t.label ? ` · ${t.label}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {turn && turns.length === 1 && turn.label && (
              <p className="wd-web-turn-label wd-web-muted">{turn.label}</p>
            )}
            <DiffModeToggle />
            {pending && (
              <DiffUpdateChip
                filesChanged={pendingFileCount}
                onShow={applyPending}
                onReload={reloadFromTop}
              />
            )}
            {(stale || loading || (checking && !pending)) && (
              <DiffBusyChip
                label={stale || loading ? 'loading…' : 'checking…'}
              />
            )}
          </header>
          {!isEmpty && activeRepo && (
            <>
              <div
                ref={treeScrollRef}
                className={
                  'wd-sidebar-split-top' + (stale ? ' wd-diff-stale' : '')
                }
                inert={stale}
              >
                <FileTree
                  files={activeRepo.files}
                  startIndex={activeStart}
                  selectedAnchor={activeAnchor}
                  viewedAnchors={viewedAnchors}
                />
              </div>
              <ResizeDivider
                layoutRef={sidebarRef}
                size={commentsHeight}
                onCommit={setCommentsHeight}
                spec={COMMENTS_SPEC}
              />
              <div className="wd-sidebar-split-bottom">
                <CommentsPanel repoName={activeRepo.name} />
              </div>
            </>
          )}
        </aside>
        <ResizeDivider
          layoutRef={layoutRef}
          size={sidebarWidth}
          onCommit={setSidebarWidth}
        />
        <main
          ref={mainRef}
          // `stale` = still showing the previously selected session's (or
          // base's) diff while this one loads: dim + blur it so it can't be
          // mistaken for the selected session's changes.
          className={'wd-web-review-main' + (stale ? ' wd-diff-stale' : '')}
          aria-busy={loading || stale}
          inert={stale}
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
              {!turn && diffBase === 'uncommitted' && (
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
                hunkScopeKey={hunkScopeKey}
              />
            </>
          )}
        </main>
        {!isEmpty && <PendingPill />}
      </div>
     </RevertContext.Provider>
    </ReviewProvider>
  );
}
