import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PrDiscussionThreadWire, PrReviewWire } from '../../../../../../core/api-types.js';
import type { ParsedFile } from '../../../../../../core/diff/diff-parse.js';
import { openThreadsByFile } from '../../../../../../core/review/review-discussion.js';
import { DiffFile } from '../../../Diff/DiffFile.js';
import { ResizeDivider, useResizableSize, type ResizeSpec } from '../../../Layout/ResizeDivider.js';
import {
  commentsByFile,
  fileOnScreen,
  filesTree,
  filesViewed,
  foldedInFiles,
  plainProse,
  type FileNode,
} from '../../../../state/review-view.js';
import { FileRow, FileSummary, FolderPath } from './ReviewText.js';
import { DiscussionAside } from './Discussion.js';

const TREE_SPEC: ResizeSpec = {
  storageKey: 'work-web:review-files-tree-width',
  cssVar: '--review-tree-width',
  defaultPx: 300,
  min: 180,
  max: 560,
  axis: 'x',
  label: 'Resize the file tree',
};

/** A file's anchor in the Files view. */
export const filesAnchor = (n: number, path: string) => `review-files-${n}-${path.replace(/[^\w-]/g, '_')}`;

/**
 * GitHub's "Files changed": every file of the PR in folder order — a folder tree on the left (the same rows as the
 * stories': change badge, name, counts, diffstat, comment pills, ✓ once viewed), every diff in one scroll on the
 * right in the tree's order, the one on screen marked in the tree. Generated files are folded until "Load diff", as
 * GitHub does. The Viewed ticks are the stories' (one set per review and head). Drafts and the PR's existing threads
 * sit on their lines; the threads that can't (outdated, or on a line the diff doesn't show) are listed on top.
 */
export function FilesView({
  review: r,
  files,
  viewed,
  onViewed,
  file,
  onFile,
  aside,
}: {
  review: PrReviewWire;
  files: ParsedFile[] | null;
  viewed: ReadonlySet<string>;
  onViewed: (path: string, on: boolean) => void;
  /** The file the URL names (scrolled to once its diff is there). */
  file?: string;
  /** A file picked in the tree (the URL follows). */
  onFile: (path: string) => void;
  /** The PR's threads not on a line of the diff (outdated, or elsewhere). */
  aside: PrDiscussionThreadWire[];
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const { size: treeWidth, setSize: setTreeWidth } = useResizableSize(TREE_SPEC);
  const tree = useMemo(() => filesTree(r.files), [r.files]);
  const byPath = useMemo(() => new Map((files ?? []).map((f) => [f.path, f])), [files]);
  const comments = useMemo(() => commentsByFile(r), [r]);
  const threads = useMemo(() => openThreadsByFile(r.discussion), [r.discussion]);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [onScreen, setOnScreen] = useState<string | null>(tree.order[0] ?? null);
  const frame = useRef(0);
  const picked = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const anchor = useCallback((path: string) => filesAnchor(r.number, path), [r.number]);
  const track = useCallback(() => {
    if (picked.current) {
      clearTimeout(settle.current);
      settle.current = setTimeout(() => (picked.current = false), 200);
      return;
    }
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const pane = paneRef.current;
      if (!pane) return;
      const top = pane.getBoundingClientRect().top;
      const tops = tree.order.flatMap((path) => {
        const el = document.getElementById(anchor(path));
        return el ? [{ path, top: el.getBoundingClientRect().top - top }] : [];
      });
      setOnScreen(fileOnScreen(tops, 16));
    });
  }, [tree.order, anchor]);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      clearTimeout(settle.current);
    },
    [],
  );
  const goTo = useCallback(
    (path: string, smooth = true) => {
      setOnScreen(path);
      picked.current = true;
      clearTimeout(settle.current);
      settle.current = setTimeout(() => (picked.current = false), 400);
      document.getElementById(anchor(path))?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    },
    [anchor],
  );
  // The tree keeps the file on screen in view (48 files are taller than the window).
  const treeRef = useRef<HTMLElement>(null);
  useEffect(() => {
    treeRef.current?.querySelector('.wd-review-filerow-current')?.scrollIntoView?.({ block: 'nearest' });
  }, [onScreen]);
  // The file the URL names, once the diffs are drawn (a reload, a link).
  const loaded = files !== null;
  // The diffs above it settle a moment later (highlighting, folded imports), moving it: it's brought back twice more,
  // unless you scrolled meanwhile.
  useEffect(() => {
    if (!loaded || !file) return;
    const pane = paneRef.current;
    const timers = [0, 300, 1200].map((ms) => setTimeout(() => goTo(file, false), ms));
    const stop = () => timers.forEach(clearTimeout);
    pane?.addEventListener('wheel', stop, { once: true });
    pane?.addEventListener('pointerdown', stop, { once: true });
    window.addEventListener('keydown', stop, { once: true });
    return () => {
      stop();
      pane?.removeEventListener('wheel', stop);
      pane?.removeEventListener('pointerdown', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [loaded, file]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the diffs arrive or the link changes, not on every goTo identity
  const progress = filesViewed(r, viewed);
  const toggle = (path: string) =>
    setClosed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const node = (n: FileNode, depth: number) =>
    n.kind === 'folder' ? (
      <li key={`d:${n.path}`} className="wd-review-ftree-folder">
        <button
          type="button"
          className="wd-review-ftree-dir"
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
          onClick={() => toggle(n.path)}
          aria-expanded={!closed.has(n.path)}
          title={n.path}
        >
          <span className="wd-chevron" aria-hidden>
            {closed.has(n.path) ? '▸' : '▾'}
          </span>
          <FolderPath folder={n.name} />
        </button>
        {!closed.has(n.path) && <ul>{n.children.map((c) => node(c, depth + 1))}</ul>}
      </li>
    ) : (
      <li key={n.path} style={{ paddingLeft: `${depth * 12}px` }}>
        <FileRow
          path={n.path}
          file={n.file}
          comments={comments.get(n.path) ?? 0}
          threads={threads.get(n.path) ?? 0}
          viewed={viewed.has(n.path)}
          current={onScreen === n.path}
          folder={false}
          bar
          className="wd-review-tree-file"
          nameClass="wd-review-tree-name"
          onClick={() => {
            goTo(n.path);
            onFile(n.path);
          }}
          title={n.file.summary ? `${n.path}\n\n${plainProse(n.file.summary)}` : `${n.path} — ${n.file.why}`}
        />
      </li>
    );
  return (
    <div className="wd-review-pager wd-review-files">
      <div className="wd-review-pagerbar" role="navigation" aria-label="Files">
        <strong className="wd-review-pager-pos">
          {r.files.length} file{r.files.length === 1 ? '' : 's'} changed
        </strong>
        <span className="wd-review-progress" title="Files ticked Viewed (the same ticks as in the stories)">
          {progress.viewed} / {progress.total} viewed
          <span className="wd-review-progress-bar" aria-hidden>
            <span style={{ width: `${progress.total ? Math.round((progress.viewed / progress.total) * 100) : 0}%` }} />
          </span>
        </span>
      </div>
      <div className="wd-review-body" ref={bodyRef} style={{ ['--review-tree-width' as string]: `${treeWidth}px` }}>
        <nav className="wd-review-tree wd-review-ftree" aria-label="Files, by folder" ref={treeRef}>
          <ul>{tree.nodes.map((n) => node(n, 0))}</ul>
        </nav>
        <ResizeDivider layoutRef={bodyRef} size={treeWidth} onCommit={setTreeWidth} spec={TREE_SPEC} />
        <div className="wd-review-diff-pane" ref={paneRef} onScroll={track}>
          {aside.length > 0 && <DiscussionAside threads={aside} {...(r.host ? { host: r.host } : {})} />}
          {tree.order.map((path) => {
            const f = byPath.get(path);
            const w = r.files.find((x) => x.path === path);
            return (
              <div key={path} className="wd-review-file">
                {f ? (
                  <DiffFile
                    file={f}
                    anchor={anchor(path)}
                    review
                    repo={r.repo}
                    foldImports
                    viewed={viewed.has(path)}
                    onToggleViewed={(on) => onViewed(path, on)}
                    note={w?.summary ? <FileSummary summary={w.summary} /> : undefined}
                    {...(w && foldedInFiles(w) ? { deferred: `Generated file — not rendered by default (${w.why}).` } : {})}
                  />
                ) : (
                  <p className="wd-start-note" id={anchor(path)}>
                    {files === null ? 'Loading the diff…' : `${path}: its diff is not available — prepare the review again.`}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
