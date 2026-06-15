import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchCheckpoints,
  fetchCheckpointSummary,
  fetchScopeDiff,
  fetchScopeDiffByHash,
  staticHasBranchScope,
  type CheckpointEntry,
  type CheckpointRangeEnd,
  type DiffBase,
  type RepoData,
  type ReviewContext,
} from '../api/client.js';
import { useSse } from '../api/events.js';
import { useDeferredDiffLoad } from '../hooks/use-deferred-diff-load.js';
import { decideRange, rangeEmptyMessage } from '../state/checkpoint-range.js';
import { CheckpointStrip } from '../components/Diff/CheckpointStrip.js';
import { DiffLoadingBar } from '../components/Diff/DiffLoadingBar.js';
import { DiffRepo } from '../components/Diff/DiffRepo.js';
import { ReviewProvider } from '../state/ReviewProvider.js';
import { ExpandProvider } from '../state/ExpandProvider.js';
import { scopeHashReviewApi } from '../api/review-api.js';
import { PendingPill } from '../components/Review/PendingPill.js';
import { EndReviewButton } from '../components/Review/EndReviewButton.js';
import { GeneralPane } from '../components/Review/GeneralPane.js';
import { FileTree } from '../components/Sidebar/FileTree.js';
import { CommentsPanel } from '../components/Sidebar/CommentsPanel.js';
import { useViewedFiles } from '../hooks/use-viewed-files.js';
import { useScrollspy } from '../hooks/use-scrollspy.js';
import { useSidebarOverflowsViewport } from '../hooks/use-sidebar-overflow.js';
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
  const [reloadKey, setReloadKey] = useState(0);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);
  const readOnly = !!context.readOnly;
  // Flips true when this scope's review ends (End Review here or in
  // another tab). Used to close this tab's SSE streams: an ended review
  // doesn't need live updates, and idle tabs that keep their EventSources
  // open pin browser connection slots — a few stale review tabs could
  // starve the per-host pool and hang every later fetch.
  const [reviewEnded, setReviewEnded] = useState(false);
  // Stable api identity (a fresh object per render would re-trigger the
  // provider's refetch effect on every render). When the review has
  // ended, hand the provider a variant with no SSE path so it
  // disconnects its stream.
  const reviewApi = useMemo(
    () => (scopeHash ? scopeHashReviewApi(scopeHash) : undefined),
    [scopeHash],
  );
  const effectiveReviewApi = useMemo(
    () =>
      reviewApi && reviewEnded ? { ...reviewApi, ssePath: '' } : reviewApi,
    [reviewApi, reviewEnded],
  );
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

  // Checkpoint range — only meaningful in scope-mounted mode (work web).
  // `null` means "no range selected yet, use default base mode" — the
  // initial state until checkpoints load. `userPicked` flips true once
  // the user manually selects a chip; from then on we don't auto-shift
  // the selection when a new checkpoint arrives.
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const [range, setRange] = useState<{
    from: number;
    to: CheckpointRangeEnd;
  } | null>(null);
  const userPickedRef = useRef(false);
  // Whether the checkpoint range actually drives the diff. `decideRange`
  // auto-pins a range (Initial → working) for the strip's display whenever
  // 2+ checkpoints exist, but it must NOT hijack the Uncommitted/Since-branch
  // tabs — the server treats a from/to range as overriding `base`, so a
  // pinned range would silently serve the checkpoint diff under whichever
  // base tab looks selected. Range comparison is opt-in: clicking a chip
  // turns it on, clicking a base tab turns it back off.
  const [rangeActive, setRangeActive] = useState(false);
  // True while a lazy checkpoint-summary request is in flight for the
  // currently-selected `to` checkpoint.
  const [summarizing, setSummarizing] = useState(false);

  // Fetch checkpoint list on scope-mount + whenever a checkpoint event
  // arrives. Default range = (last → working), so the user sees "what
  // changed since the last automatic snapshot" without any clicks.
  const refreshCheckpoints = useCallback(() => {
    if (!scopeHash) return;
    fetchCheckpoints(scopeHash).then(
      (entries) => {
        setCheckpoints(entries);
        setRange((prev) => {
          const decision = decideRange(
            entries,
            userPickedRef.current,
            prev,
          );
          if (decision.resetUserPicked) userPickedRef.current = false;
          if (decision.kind === 'legacy') return null;
          return decision.range;
        });
      },
      () => { /* silent — strip just stays hidden */ },
    );
  }, [scopeHash]);

  useEffect(() => {
    refreshCheckpoints();
  }, [refreshCheckpoints]);

  // Diff fetch + deferred loading state lives in the shared hook so the
  // timing logic (and the "clear the show-timer the moment the fetch
  // settles" rule) stays in one place for both this view and DiffView.
  const {
    data: diffData,
    error,
    loading,
  } = useDeferredDiffLoad(
    () =>
      scopeHash
        ? fetchScopeDiffByHash(
            scopeHash,
            diffBase,
            rangeActive ? (range ?? undefined) : undefined,
          )
        : fetchScopeDiff(diffBase),
    [reloadKey, diffBase, scopeHash, range, rangeActive],
  );
  const repos: RepoData[] | null = diffData?.repos ?? null;
  const resolvedBase = diffData?.resolvedBase;
  // Standalone mode puts the branch on the context; work-web scope views
  // synthesize their context from the URL hash, so it arrives on the diff.
  const headBranch = context.headBranch ?? diffData?.headBranch;

  // Reflect the comparison in the browser tab title: "<branch> vs <base>".
  useEffect(() => {
    const head = headBranch ?? 'HEAD';
    let what: string;
    if (rangeActive && range) {
      const from = range.from === 0 ? 'Initial' : `#${range.from}`;
      const to = range.to === 'working' ? 'working' : `#${range.to}`;
      what = `${from} → ${to}`;
    } else if (diffBase === 'branch' && resolvedBase) {
      what = `${head} vs ${resolvedBase}`;
    } else {
      what = `${head} · uncommitted`;
    }
    document.title = `${what} — ${context.scopeLabel}`;
  }, [headBranch, context.scopeLabel, diffBase, resolvedBase, rangeActive, range]);

  // In scope-mounted mode, listen to the scope-narrowed SSE stream — it
  // fires for THIS scope's file/checkpoint/review events. Standalone mode
  // uses the global /events stream (its diff server only handles one
  // scope). Once the review ends, disconnect (`null` URL) — see
  // `reviewEnded` above.
  useSse(
    reviewEnded
      ? null
      : scopeHash
        ? `/api/scopes/${encodeURIComponent(scopeHash)}/events`
        : '/events',
    {
      events: {
        'diff-changed': () => setReloadKey((n) => n + 1),
        'checkpoints-changed': () => refreshCheckpoints(),
        'review-done': () => setReviewEnded(true),
      },
    },
  );

  // Plain click sets `to`. Shift-click sets `from`. Each endpoint is
  // independent — moving one never silently resets the other. This is
  // the model GitHub uses on its commit-range picker too: click to
  // anchor one side, shift-click to anchor the other.
  //
  // After every change, normalise so `from <= to` (treating 'working'
  // as +∞). The server rejects reversed ranges with 400; without this,
  // shift-clicking past the current `to` would 400 every diff fetch
  // until the user clicks again to fix it.
  const normaliseRange = (
    from: number,
    to: CheckpointRangeEnd,
  ): { from: number; to: CheckpointRangeEnd } => {
    if (to === 'working') return { from, to };
    if (from > to) return { from: to, to: from };
    return { from, to };
  };
  // Switch to a plain base diff (Uncommitted / Since branch), turning off
  // any active checkpoint-range comparison so the tab actually takes effect.
  const selectBase = (base: DiffBase) => {
    setRangeActive(false);
    setDiffBase(base);
  };
  // Dropdown endpoint setters. Each keeps the other endpoint and activates
  // the range comparison; normaliseRange guards against a reversed pick.
  const setRangeFrom = (id: number) => {
    userPickedRef.current = true;
    setRangeActive(true);
    setRange((prev) => normaliseRange(id, prev?.to ?? 'working'));
  };
  const setRangeTo = (end: CheckpointRangeEnd) => {
    userPickedRef.current = true;
    setRangeActive(true);
    setRange((prev) => normaliseRange(prev?.from ?? 0, end));
  };
  // Plain-click a checkpoint → show JUST its own diff: the previous checkpoint
  // → this one. 'working' → changes since the last checkpoint; Initial → the
  // whole thing (it has no predecessor). Uses the ordered list so it's robust
  // to any id gaps.
  const pickSingleCheckpoint = (end: CheckpointRangeEnd) => {
    userPickedRef.current = true;
    setRangeActive(true);
    if (end === 'working') {
      const lastId = checkpoints.length
        ? checkpoints[checkpoints.length - 1].id
        : 0;
      setRange({ from: lastId, to: 'working' });
      return;
    }
    if (end === 0) {
      setRange({ from: 0, to: 'working' }); // Initial = everything from the start
      return;
    }
    const idx = checkpoints.findIndex((e) => e.id === end);
    const fromId = idx > 0 ? checkpoints[idx - 1].id : 0;
    setRange({ from: fromId, to: end });
  };

  useEffect(() => {
    if (!repos || repos.length === 0) return;
    if (!repos.some((r) => r.name === activeRepoName)) {
      setActiveRepoName(repos[0].name);
    }
  }, [repos, activeRepoName]);

  // Lazily fetch a Claude summary for the selected `to` checkpoint (skipping
  // Initial / Working and anything already summarised). The server caches the
  // result in the manifest `label`; we patch it into local state so the
  // dropdown option + subtitle update without waiting for an SSE refresh.
  useEffect(() => {
    // Any path where we are NOT fetching must clear `summarizing` — otherwise
    // the "summarising…" subtitle stays stuck. This matters because the
    // auto-latest pass below can land the label for the selected `to` while
    // our fetch is in flight: `checkpoints` then changes, this effect re-runs,
    // finds the entry already labelled, and must reset the flag rather than
    // return early with it left on.
    if (!scopeHash || !rangeActive || !range || range.to === 'working' || range.to === 0) {
      setSummarizing(false);
      return;
    }
    const toId = range.to;
    const entry = checkpoints.find((e) => e.id === toId);
    if (!entry || (entry.label && entry.label.trim())) {
      setSummarizing(false);
      return;
    }
    let cancelled = false;
    setSummarizing(true);
    fetchCheckpointSummary(scopeHash, toId).then(
      ({ label }) => {
        if (cancelled) return;
        setSummarizing(false);
        if (label && label.trim()) {
          setCheckpoints((prev) =>
            prev.map((e) => (e.id === toId ? { ...e, label } : e)),
          );
        }
      },
      () => {
        if (!cancelled) setSummarizing(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scopeHash, rangeActive, range, checkpoints]);

  // Eagerly summarise the MOST RECENT checkpoint (debounced) so the picker's
  // newest entry reads as a summary, not a bare #id — that's the one the user
  // most often wants ("what did the latest change do?"). The 2.5s settle
  // window means a burst of saves only summarises the final, stable state
  // rather than every transient checkpoint in between.
  useEffect(() => {
    if (!scopeHash || checkpoints.length === 0) return;
    const latest = checkpoints[checkpoints.length - 1];
    if (latest.id === 0 || (latest.label && latest.label.trim())) return;
    const timer = setTimeout(() => {
      fetchCheckpointSummary(scopeHash, latest.id).then(
        ({ label }) => {
          if (label && label.trim()) {
            setCheckpoints((prev) =>
              prev.map((e) => (e.id === latest.id ? { ...e, label } : e)),
            );
          }
        },
        () => { /* leave it as #id; selecting it will retry */ },
      );
    }, 2500);
    return () => clearTimeout(timer);
  }, [scopeHash, checkpoints]);

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
  // In page-scroll mode the sidebar stays in the document's scroll box (so
  // Ctrl+F ticks for file-tree matches share the viewport scrollbar) until
  // the tree is taller than the viewport, when it becomes its own scroller.
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarScrolls = useSidebarOverflowsViewport(sidebarRef, [
    activeRepo?.name,
    repos?.length,
  ]);

  // ---- Hooks above this line, branches below ----------------------------

  if (error) return <div className="wd-web-error">{error}</div>;
  if (!repos) return <div className="wd-web-empty">Loading diff…</div>;

  const totalFiles = repos.reduce((s, r) => s + r.files.length, 0);
  const isEmpty = totalFiles === 0 || !activeRepo;
  const hasTabs = repos.length > 1;
  // Empty-state copy mirrors DiffView's three-bucket diagnostic so the
  // user knows whether detection failed or the branch is just up to
  // date. Range mode adds a fourth bucket — picking two checkpoints
  // that bracket no work returns an empty diff, and the user needs
  // to know which range produced it (not be told "No uncommitted
  // changes" when their tree has plenty).
  let emptyMessage: string;
  if (rangeActive && range) {
    const latestId = checkpoints.length
      ? checkpoints[checkpoints.length - 1].id
      : undefined;
    emptyMessage = rangeEmptyMessage(range, latestId);
  } else if (diffBase === 'uncommitted') {
    emptyMessage = 'No uncommitted changes.';
  } else if (!resolvedBase || resolvedBase === 'HEAD') {
    emptyMessage =
      "Couldn't auto-detect this branch's parent. " +
      'Tried main, master, dev, develop (and their origin/* mirrors).';
  } else {
    emptyMessage = `No commits since \`${resolvedBase}\` — branch is up to date or already merged.`;
  }

  // Sticky toolbar over the diff, GitHub "Files changed" style: identity +
  // file count + comparison summary on the left, the diff-scope tabs and the
  // checkpoint range picker on the right. Pinned to the top of the scroll so
  // the range picker (and what you're comparing) stays visible while you
  // scroll a long diff. Rendered for every state — including empty — so the
  // controls that let you escape an empty range/base are always reachable.
  const compareSummary =
    rangeActive && range ? (
      <>
        <strong>{range.from === 0 ? 'Initial' : `#${range.from}`}</strong>
        <span className="wd-web-muted"> → </span>
        <strong>{range.to === 'working' ? 'working' : `#${range.to}`}</strong>
      </>
    ) : diffBase === 'branch' && resolvedBase ? (
      <>
        <strong>{headBranch ?? 'HEAD'}</strong>
        <span className="wd-web-muted"> vs </span>
        <strong>{resolvedBase}</strong>
      </>
    ) : (
      <>
        <span className="wd-web-muted">uncommitted on </span>
        <strong>{headBranch ?? 'working tree'}</strong>
      </>
    );
  const toolbar = (
    <div className="wd-web-difftoolbar">
      <div className="wd-web-difftoolbar-info">
        <span className="wd-web-difftoolbar-title" title={context.scopeLabel}>
          {context.scopeLabel}
        </span>
        <span className="wd-web-difftoolbar-count">
          {isEmpty ? (
            <span className="wd-web-muted">no changes</span>
          ) : (
            <>
              {totalFiles} file{totalFiles === 1 ? '' : 's'} changed
              {hasTabs ? ` · ${repos.length} repos` : ''}
            </>
          )}
        </span>
        <span className="wd-web-difftoolbar-compare">{compareSummary}</span>
      </div>
      <div className="wd-web-difftoolbar-controls">
        {hasBranchTab && (
          <div
            className="wd-web-diff-scope"
            role="tablist"
            aria-label="Diff scope"
          >
            <button
              type="button"
              role="tab"
              aria-selected={!rangeActive && diffBase === 'uncommitted'}
              className={
                'wd-web-diff-scope-btn' +
                (!rangeActive && diffBase === 'uncommitted'
                  ? ' wd-web-diff-scope-btn-active'
                  : '')
              }
              onClick={() => selectBase('uncommitted')}
            >
              Uncommitted
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={!rangeActive && diffBase === 'branch'}
              className={
                'wd-web-diff-scope-btn' +
                (!rangeActive && diffBase === 'branch'
                  ? ' wd-web-diff-scope-btn-active'
                  : '')
              }
              onClick={() => selectBase('branch')}
            >
              Since branch
            </button>
          </div>
        )}
        {/* Range picker lives in the toolbar so it's pinned with everything
           else. Outside the empty/non-empty fork — a chip pick that produces
           an empty range must not strand the user. */}
        {scopeHash && checkpoints.length > 1 && range && (
          <CheckpointStrip
            entries={checkpoints}
            fromId={range.from}
            toId={range.to}
            active={rangeActive}
            onChangeFrom={setRangeFrom}
            onChangeTo={setRangeTo}
            onPickSingle={pickSingleCheckpoint}
            busy={loading}
            summary={
              range.to !== 'working' && range.to !== 0
                ? (checkpoints.find((e) => e.id === range.to)?.label ?? null)
                : null
            }
            summaryLoading={summarizing}
          />
        )}
      </div>
    </div>
  );

  // In read-only mode (static files, `wd`, `wd --server`) there's no
  // backing comment server — mounting ReviewProvider would trigger a
  // useless fetch('/api/comments') that 405s on a server and CORS-fails
  // over file://. The layout works fine without the provider; every
  // child that needs review state already calls useReviewOptional().
  const layout = (
    <div
      // Full-width column: the sticky toolbar spans the whole viewport, with
      // the sidebar tree + diff grid below it (GitHub "Files changed" shape).
      // CSS vars live here so they cascade to BOTH the toolbar and the grid:
      //   --topbar-h   reserves the sticky toolbar's height (sidebar sticks
      //                below it; in-diff sticky headers offset by it).
      //   --tabs-offset is the repo-tabs bar height (0 when no group tabs).
      //   --sidebar-width drives the grid's sidebar column.
      // `layoutRef` MUST be on this element — the one that owns the
      // React-managed `--sidebar-width` — because ResizeDivider writes that
      // var imperatively to `layoutRef.current` during a drag. If it pointed
      // at the inner grid instead, the grid would keep a stale inline var that
      // shadows state-driven updates (double-click reset would never apply).
      ref={layoutRef}
      className="wd-web-review-page"
      style={{
        ['--sidebar-width' as string]: `${sidebarWidth}px`,
        ['--topbar-h' as string]: '40px',
        ['--tabs-offset' as string]: hasTabs ? '36px' : '0px',
      }}
    >
      {toolbar}
      <div
        // `--page` makes the diff scroll on the document, not an inner box, so
        // Chrome paints Ctrl+F match ticks on the viewport scrollbar. Only this
        // full-page view opts in — the dashboard's DiffView keeps the bounded
        // inner scroller (see .wd-web-review-layout--page in review.css).
        className="wd-web-review-layout wd-web-review-layout--page"
      >
        <aside
          ref={sidebarRef}
          className={
            'wd-web-review-sidebar' +
            (sidebarScrolls ? ' wd-sidebar-scrolls' : '')
          }
        >
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
        <main className="wd-web-review-main" aria-busy={loading}>
          {loading && <DiffLoadingBar />}
          {isEmpty || !activeRepo ? (
            <div className="wd-web-empty wd-web-empty-diff">
              <p>{emptyMessage}</p>
              {diffBase === 'uncommitted' && hasBranchTab && (
                <p className="wd-web-empty-hint">
                  Try{' '}
                  <button
                    type="button"
                    className="wd-web-link-btn"
                    onClick={() => selectBase('branch')}
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
    </div>
  );

  // "Expand lines" reads file content from the server, so it's wired in
  // every server-backed mode (read-only `wd` included) but suppressed for
  // static `wd --static` files, which have no backend to fetch from.
  const withExpand = (node: ReactNode) =>
    context.staticMode ? (
      node
    ) : (
      <ExpandProvider scopeHash={scopeHash}>{node}</ExpandProvider>
    );

  if (readOnly) return withExpand(layout);
  // For scope-mounted review (`/review/<hash>`), point the provider at
  // the scope's comment endpoints (memoized above). Standalone `wd -c`
  // uses the default scopeReviewApi which targets the bare `/api/comments`.
  return withExpand(
    <ReviewProvider api={effectiveReviewApi}>{layout}</ReviewProvider>,
  );
}
