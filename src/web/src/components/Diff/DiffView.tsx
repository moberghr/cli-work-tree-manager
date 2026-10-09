import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchDiffSeen,
  fetchSessionDiff,
  fetchSessionHistory,
  markDiffSeen,
  revertChange,
  sessionDiffPage,
  type CheckpointEntry,
  type RepoData,
  type SessionCommit,
  type SessionSummary,
} from '../../api/client.js';
import { sessionReviewApi } from '../../api/review-api.js';
import { useSse } from '../../api/events.js';
import { useDeferredDiffLoad } from '../../hooks/use-deferred-diff-load.js';
import { ReviewProvider, useReview } from '../../state/ReviewProvider.js';
import { RevertContext, type RevertApi } from '../../state/RevertProvider.js';
import { DiffRepo } from './DiffRepo.js';
import { DiffUpdateChip } from './DiffUpdateChip.js';
import { DiffModeToggle } from './DiffModeToggle.js';
import { HistoryPicker } from './HistoryPicker.js';
import { FileTree } from '../Sidebar/FileTree.js';
import { CommentsPanel } from '../Sidebar/CommentsPanel.js';
import { GeneralPane } from '../Review/GeneralPane.js';
import { PendingPill } from '../Review/PendingPill.js';
import { useViewedFiles } from '../../hooks/use-viewed-files.js';
import { useCommentJump } from '../../hooks/use-comment-jump.js';
import { useFollowActiveInSidebar, useScrollspy } from '../../hooks/use-scrollspy.js';
import { COMMENTS_SPEC, ResizeDivider, useResizableSize, useSidebarWidth } from '../Layout/ResizeDivider.js';
import { useLookedFor } from '../../hooks/use-looked.js';
import { modalOpen } from '../../state/modal-open.js';
import { fileSignature, newestCheckpoint } from '../../state/diff-seen.js';
import {
  historyItems,
  lastTurn,
  liveLabel,
  selectionKey,
  selectionRange,
  sinceLooked,
  SINCE_BRANCH,
  UNCOMMITTED,
  type DiffSelection,
} from '../../state/diff-history.js';
import { emptyDiffMessage, orderRepoTabs, preferredRepo } from '../../state/diff-view.js';
import type { DiffSeen } from '../../../../core/api-types.js';
import { pointParam } from '../../../../core/diff/diff-points.js';

/** Looked at this long (visible, focused) and the diff counts as seen. */
const LOOKED_MS = 5000;
/** A change outside a turn (a commit by hand) re-reads the commit list at most this often. */
const HISTORY_RELOAD_MS = 5000;

interface Props {
  session: SessionSummary;
  /** Open on "Last turn" once the session's turns are known (the review
   *  queue, and finished sessions opened from the inbox). */
  startOnLastTurn?: boolean;
  /** The diff fills the window (the session page hides its header, tabs and the rail around it); Esc leaves. */
  fullScreen?: boolean;
  onFullScreen?: (on: boolean) => void;
}

/**
 * The single-session view inside `work web`: the standalone review page's
 * shape (a toolbar over the file tree and the diff) with the session's whole
 * history to pick from — the branch's commits and Claude's turns, any one or
 * any span of them, in either scope.
 *
 * All hooks must run unconditionally on every render — branching on
 * `diff === null` happens after the hooks.
 */
export function DiffView({ session, startOnLastTurn = false, fullScreen = false, onFullScreen }: Props) {
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  // The diff's page of its own (the one wd opens), set up when the tab opens, so the link is plain by the time it's clicked.
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  useEffect(() => {
    setPageUrl(null);
    if (session.archivedAt) return;
    let live = true;
    sessionDiffPage(session.id).then(
      (url) => live && setPageUrl(url),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session.id, session.archivedAt]);
  useEffect(() => {
    if (!fullScreen) return;
    // Esc leaves — unless it closed something on the way (the diff's pickers mark it used) or a menu or dialog is
    // open and takes it: that Esc is theirs. (The top bar's popovers are under the full-screen diff.)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || modalOpen()) return;
      onFullScreen?.(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreen, onFullScreen]);
  // A repo tab you clicked stays yours; otherwise the first repo with changes is shown.
  const pickedRepo = useRef<string | null>(null);
  const [selection, setSelection] = useState<DiffSelection>(UNCOMMITTED);
  const [entries, setEntries] = useState<CheckpointEntry[]>([]);
  const [commits, setCommits] = useState<SessionCommit[]>([]);
  // A late answer for the previous session must not land on this one.
  const historyFor = useRef(session.id);
  historyFor.current = session.id;
  const historyAt = useRef(0);
  // Its turns' scope: every Diff tab hears every session's checkpoints-changed.
  const scopeHash = useRef<string | null>(null);
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadHistory = () => {
    const id = session.id;
    historyAt.current = Date.now();
    fetchSessionHistory(id).then(
      (h) => {
        if (historyFor.current !== id) return;
        scopeHash.current = h.scopeHash;
        setEntries(h.entries);
        setCommits(h.commits);
      },
      () => historyFor.current === id && setEntries([]),
    );
  };
  // At most once per HISTORY_RELOAD_MS, and never dropped: a change inside the
  // window is read at its end (a commit made right after a turn must show up).
  const loadHistorySoon = () => {
    const wait = HISTORY_RELOAD_MS - (Date.now() - historyAt.current);
    if (wait <= 0) return loadHistory();
    historyTimer.current ??= setTimeout(() => {
      historyTimer.current = null;
      loadHistory();
    }, wait);
  };
  // "Since you looked": how far you had looked when this visit began (kept for
  // the whole visit; looking now moves the server's mark, not this one).
  const [seenAtOpen, setSeenAtOpen] = useState<DiffSeen | null | undefined>(undefined);
  useEffect(() => {
    setSelection(UNCOMMITTED);
    setEntries([]);
    setCommits([]);
    setSeenAtOpen(undefined);
    pickedRepo.current = null;
    scopeHash.current = null;
    if (historyTimer.current) clearTimeout(historyTimer.current);
    historyTimer.current = null;
    loadHistory();
    const id = session.id;
    fetchDiffSeen(id).then(
      (s) => historyFor.current === id && setSeenAtOpen(s),
      () => historyFor.current === id && setSeenAtOpen(null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  useEffect(
    () => () => {
      if (historyTimer.current) clearTimeout(historyTimer.current);
    },
    [],
  );

  const isGroup = session.paths.length > 1;
  // Every repo's commits, for what a pick means (a commit of another repo
  // stays picked when you switch tabs); the tab's own, for the list.
  const allItems = useMemo(() => historyItems(entries, commits, null), [entries, commits]);
  const items = useMemo(() => historyItems(entries, commits, isGroup ? activeRepoName : null), [entries, commits, isGroup, activeRepoName]);
  const turnShortcut = useMemo(() => lastTurn(allItems), [allItems]);
  const lookedShortcut = useMemo(() => sinceLooked(allItems, entries, seenAtOpen?.checkpointId), [allItems, entries, seenAtOpen]);

  const newest = newestCheckpoint(entries);
  // Once per visit: open on the last turn when asked to (the review queue),
  // else on what changed since you last looked, when Claude finished a turn after it.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (opened.current === session.id) return;
    if (startOnLastTurn) {
      if (!turnShortcut) return;
      opened.current = session.id;
      setSelection(turnShortcut);
      return;
    }
    if (seenAtOpen === undefined || entries.length === 0) return;
    opened.current = session.id;
    if (lookedShortcut) setSelection(lookedShortcut);
  }, [startOnLastTurn, turnShortcut, lookedShortcut, seenAtOpen, entries.length, session.id]);
  // Looked at it for a few seconds: that's how far you have seen, for next time.
  useLookedFor(newest === null ? null : `${session.id}:${newest}`, LOOKED_MS, () => {
    if (newest !== null) void markDiffSeen(session.id, newest).catch(() => {});
  });

  // A span whose rows are gone (a commit rewritten by a rebase) shows what's uncommitted instead.
  const range = selectionRange(allItems, selection);
  const shown: DiffSelection = selection.kind === 'range' && !range ? UNCOMMITTED : selection;
  const base = shown.kind === 'scope' ? shown.base : 'uncommitted';
  // A span from or to a commit is that commit's repo alone (rangeRefs): say so in a group.
  const commitRepo = range
    ? ([range.from, range.to].map((p) => (p.kind === 'commit' || p.kind === 'parent' ? p.repo : null)).find((r) => r) ?? null)
    : null;
  const {
    data: diff,
    error,
    loading,
    pending,
    stale,
    applyPending,
    reload,
    checkForUpdates,
  } = useDeferredDiffLoad(
    () => (range ? fetchSessionDiff(session.id, 'uncommitted', range) : fetchSessionDiff(session.id, base)),
    [session.id, selectionKey(shown), range && pointParam(range.from), range && pointParam(range.to)],
  );

  useSse(`/events?session=${encodeURIComponent(session.id)}`, {
    events: {
      // Stage the new diff instead of swapping it in — a Claude turn writing
      // files must not re-render the diff under someone reading it. The
      // update chip hands control to the user. A commit made by hand shows
      // up here too, so the commit list is read again (not too often).
      'diff-changed': () => {
        checkForUpdates();
        loadHistorySoon();
      },
      // A turn finished → a new checkpoint (and maybe commits): this session's, not another's.
      'checkpoints-changed': (d) => {
        const hash = (d as { scopeHash?: string } | null)?.scopeHash;
        if (!hash || !scopeHash.current || hash === scopeHash.current) loadHistory();
      },
    },
  });

  const api = useMemo(() => sessionReviewApi(session.id), [session.id]);

  useEffect(() => {
    if (!diff || diff.repos.length === 0) return;
    const want = preferredRepo(diff.repos, activeRepoName, pickedRepo.current);
    if (want !== activeRepoName) setActiveRepoName(want);
  }, [diff, activeRepoName]);
  const openRepo = (name: string) => {
    pickedRepo.current = name;
    setActiveRepoName(name);
  };

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
  const activeStart = activeRepo ? (repoStartIndex.get(activeRepo.name) ?? 0) : 0;

  const pathToAnchor = useMemo(() => {
    const map = new Map<string, string>();
    if (!activeRepo) return map;
    activeRepo.files.forEach((f, i) => {
      map.set(f.path, `wd-file-${activeStart + i}`);
    });
    return map;
  }, [activeRepo, activeStart]);

  const scopeKey = activeRepo ? `session:${session.id}:${activeRepo.name}` : `session:${session.id}:_pending`;
  const hunkScopeKey = activeRepo ? `session:${session.id}:${activeRepo.name}:hunks` : '';
  // A Viewed tick holds while the file's change is the one you ticked (fileSignature).
  const signatures = useMemo(() => new Map((activeRepo?.files ?? []).map((f) => [f.path, fileSignature(f)])), [activeRepo]);
  const { viewedPaths, viewedAnchors, toggle: toggleViewed } = useViewedFiles(scopeKey, pathToAnchor, signatures);
  const activeAnchor = useScrollspy(`${session.id}:${activeRepo?.name ?? '_pending'}`);
  const { width: sidebarWidth, setWidth: setSidebarWidth } = useSidebarWidth();
  const { size: commentsHeight, setSize: setCommentsHeight } = useResizableSize(COMMENTS_SPEC);
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
  const canRevert = shown.kind === 'scope' && shown.base === 'uncommitted';
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

  // Busy: a pick or a session switch is loading. A quiet bar under the
  // toolbar (after a moment, so a fast load shows nothing) — the diff stays
  // put and readable; a background check after Claude writes shows nothing
  // until it has something (the update chip).
  const busy = stale || loading;
  const totalFiles = diff ? diff.repos.reduce((s, r) => s + r.files.length, 0) : 0;
  const added = diff ? diff.repos.reduce((s, r) => s + r.files.reduce((a, f) => a + f.added, 0), 0) : 0;
  const deleted = diff ? diff.repos.reduce((s, r) => s + r.files.reduce((a, f) => a + f.deleted, 0), 0) : 0;
  const reposWithChanges = diff ? diff.repos.filter((r) => r.files.length > 0).length : 0;
  // File count of the staged (not-yet-shown) diff, for the chip's summary.
  const pendingFileCount = pending ? pending.repos.reduce((s, r) => s + r.files.length, 0) : null;

  const toolbar = (
    <div className="wd-web-difftoolbar wd-dash-difftoolbar" role="toolbar" aria-label="Diff">
      <div className="wd-dash-difftoolbar-pick">
        <div className="wd-web-diff-scope" role="tablist" aria-label="Diff scope">
          <button
            type="button"
            role="tab"
            aria-selected={shown.kind === 'scope' && shown.base === 'uncommitted'}
            className={
              'wd-web-diff-scope-btn' + (shown.kind === 'scope' && shown.base === 'uncommitted' ? ' wd-web-diff-scope-btn-active' : '')
            }
            onClick={() => setSelection(UNCOMMITTED)}
            title="What isn't committed yet (git diff HEAD)"
          >
            Uncommitted
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={shown.kind === 'scope' && shown.base === 'branch'}
            className={'wd-web-diff-scope-btn' + (shown.kind === 'scope' && shown.base === 'branch' ? ' wd-web-diff-scope-btn-active' : '')}
            onClick={() => setSelection(SINCE_BRANCH)}
            title={
              session.baseBranch
                ? `Everything since this branch left ${session.baseBranch}: its commits and what isn't committed`
                : "Everything since this branch left its parent (found by itself): its commits and what isn't committed"
            }
          >
            Since branch
          </button>
        </div>
        <HistoryPicker
          // A Shift+click span starts at the last click in this session and this repo's list, never another's.
          key={`${session.id}:${isGroup ? activeRepoName : ''}`}
          items={items}
          selection={shown}
          onSelect={setSelection}
          lastTurn={turnShortcut}
          sinceLooked={lookedShortcut}
          commitsOf={isGroup ? activeRepoName : null}
        />
      </div>
      <div className="wd-web-difftoolbar-info">
        {diff && (
          <span className="wd-web-difftoolbar-count">
            {totalFiles === 0 ? (
              'no changes'
            ) : (
              <>
                {totalFiles} file{totalFiles === 1 ? '' : 's'}
                {reposWithChanges > 1 ? ` in ${reposWithChanges} repos` : ''} <span className="wd-add">+{added}</span>{' '}
                <span className="wd-del">−{deleted}</span>
              </>
            )}
          </span>
        )}
        {diff && shown.kind === 'scope' && shown.base === 'branch' && diff.resolvedBase && diff.resolvedBase !== 'HEAD' && (
          <span className="wd-web-difftoolbar-compare wd-web-muted">vs {diff.resolvedBase}</span>
        )}
        {commitRepo && isGroup && (
          <span
            className="wd-web-difftoolbar-compare wd-web-muted"
            title="A commit belongs to one repo: a span from or to one shows that repo's changes"
          >
            {commitRepo} only
          </span>
        )}
        {pending && <DiffUpdateChip filesChanged={pendingFileCount} onShow={applyPending} onReload={reloadFromTop} />}
      </div>
      <div className="wd-web-difftoolbar-controls">
        <DiffModeToggle />
        {pageUrl && (
          <a
            className="wd-btn-secondary wd-diff-open-page"
            href={pageUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open this diff in your browser, on a page of its own (as wd does)"
          >
            Open in browser ↗
          </a>
        )}
        {onFullScreen && (
          <button
            type="button"
            className="wd-btn-secondary wd-diff-fullscreen"
            aria-pressed={fullScreen}
            onClick={() => onFullScreen(!fullScreen)}
            title={fullScreen ? 'Back to the session (Esc)' : 'Fill the window with the diff'}
          >
            {fullScreen ? 'Exit full screen' : 'Full screen'}
          </button>
        )}
      </div>
      <div
        className={'wd-diff-progress' + (busy ? ' wd-diff-progress-on' : '')}
        role="progressbar"
        aria-hidden={!busy}
        aria-label="Loading the diff"
      />
    </div>
  );

  if (error)
    return (
      <>
        {toolbar}
        <div className="wd-web-error">{error}</div>
      </>
    );
  if (!diff)
    return (
      <>
        {toolbar}
        <div className="wd-web-empty wd-web-empty-diff">
          <p className="wd-web-muted">Loading the diff…</p>
        </div>
      </>
    );

  const isEmpty = totalFiles === 0 || !activeRepo;
  const hasTabs = diff.repos.length > 1;
  const emptyMessage = emptyDiffMessage(shown, diff.resolvedBase, liveLabel(allItems, shown));

  return (
    <ReviewProvider api={api}>
      <RevertContext.Provider value={revertApi}>
        {toolbar}
        <div ref={layoutRef} className="wd-web-review-layout" style={{ ['--sidebar-width' as string]: `${sidebarWidth}px` }}>
          <aside
            ref={sidebarRef}
            className="wd-web-review-sidebar wd-web-review-sidebar-split"
            style={{ [COMMENTS_SPEC.cssVar as string]: `${commentsHeight}px` }}
          >
            {!isEmpty && activeRepo ? (
              <>
                <div ref={treeScrollRef} className={'wd-sidebar-split-top' + (stale ? ' wd-diff-stale-soft' : '')} inert={stale}>
                  <FileTree files={activeRepo.files} startIndex={activeStart} selectedAnchor={activeAnchor} viewedAnchors={viewedAnchors} />
                </div>
                <SidebarComments
                  sidebarRef={sidebarRef}
                  height={commentsHeight}
                  onHeight={setCommentsHeight}
                  repoName={activeRepo.name}
                  onOpenRepo={openRepo}
                />
              </>
            ) : (
              // Nothing changed (Claude committed it all): the comments are still here.
              <div className="wd-sidebar-split-bottom wd-sidebar-comments-only">
                <CommentsPanel />
              </div>
            )}
          </aside>
          <ResizeDivider layoutRef={layoutRef} size={sidebarWidth} onCommit={setSidebarWidth} />
          <main
            ref={mainRef}
            // `stale` = still showing the previous pick's (or session's) diff
            // while this one loads: dimmed a little after a moment, and not
            // clickable, so it can't be mistaken for the new one.
            className={'wd-web-review-main' + (stale ? ' wd-diff-stale-soft' : '')}
            aria-busy={busy}
            inert={stale}
            // Always set --tabs-offset (0px when no tabs) so the value is
            // present in every render. With keep-mounted-hidden dashboard
            // nav, an incoming pane that flips from hidden to visible would
            // otherwise paint one frame without the variable — single-frame
            // layout jump when scrolling sticky-positioned file headers.
            style={{ ['--tabs-offset' as string]: hasTabs ? '36px' : '0px' }}
          >
            {isEmpty || !activeRepo ? (
              <>
                {/* Comments live here (the session has no Comments tab): with
                    nothing changed they still show, and can still be written. */}
                <GeneralPane />
                <div className="wd-web-empty wd-web-empty-diff">
                  <p>{emptyMessage}</p>
                  {shown.kind === 'scope' && shown.base === 'uncommitted' && (
                    <p className="wd-web-empty-hint">
                      Try{' '}
                      <button type="button" className="wd-web-link-btn" onClick={() => setSelection(SINCE_BRANCH)}>
                        Since branch
                      </button>{' '}
                      for everything on this branch, or pick a commit or a turn under Changes.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <GeneralPane />
                {hasTabs && (
                  <nav className="wd-web-repo-tabs">
                    {orderRepoTabs(diff.repos).map((r) => {
                      const add = r.files.reduce((s, f) => s + f.added, 0);
                      const del = r.files.reduce((s, f) => s + f.deleted, 0);
                      return (
                        <button
                          key={r.name}
                          type="button"
                          className={
                            'wd-web-repo-tab' +
                            (r.name === activeRepo.name ? ' wd-web-repo-tab-active' : '') +
                            (r.files.length === 0 ? ' wd-web-repo-tab-empty' : '')
                          }
                          onClick={() => openRepo(r.name)}
                          title={r.files.length === 0 ? 'No changes in this repo here' : undefined}
                        >
                          {r.name} <span className="wd-web-tab-count">({r.files.length})</span>{' '}
                          <span className="wd-tab-stats">
                            <span className="wd-add">+{add}</span> <span className="wd-del">-{del}</span>
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

/**
 * The comments under the file tree: resizable while there are some; with
 * none, one line at the bottom, so the tree gets the room.
 */
function SidebarComments({
  sidebarRef,
  height,
  onHeight,
  repoName,
  onOpenRepo,
}: {
  sidebarRef: React.RefObject<HTMLElement | null>;
  height: number;
  onHeight: (h: number) => void;
  repoName: string;
  onOpenRepo: (repo: string) => void;
}) {
  const none = useReview().comments.length === 0;
  return (
    <>
      {!none && <ResizeDivider layoutRef={sidebarRef} size={height} onCommit={onHeight} spec={COMMENTS_SPEC} />}
      <div className={'wd-sidebar-split-bottom' + (none ? ' wd-sidebar-comments-none' : '')}>
        <CommentsPanel repoName={repoName} onOpenRepo={onOpenRepo} />
      </div>
    </>
  );
}
