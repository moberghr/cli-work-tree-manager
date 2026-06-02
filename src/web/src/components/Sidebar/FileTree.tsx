import { useMemo, useState } from 'react';
import type { ParsedFile } from '../../api/client.js';
import { STATUS_LETTER } from '../../utils/status.js';
import { buildTree, type TreeNode } from '../../utils/tree.js';

interface Props {
  files: ParsedFile[];
  startIndex: number;
  selectedAnchor?: string | null;
}

/**
 * File tree for the current repo's diff. Click a leaf to scroll its
 * corresponding `<article>` into view. Each level mixes dirs + files in
 * one alphabetical list (matches the diff's GitHub-style file order).
 */
interface FileTreeProps extends Props {
  /** Map of anchor → viewed-flag. Drives the strikethrough styling. */
  viewedAnchors?: Set<string>;
}

export function FileTree({
  files,
  startIndex,
  selectedAnchor,
  viewedAnchors,
}: FileTreeProps) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  // We filter the flat list first, then rebuild the tree from the survivors
  // so dirs that lose all their files drop out cleanly. Indices must survive
  // filtering so anchor ids stay in sync with the diff order.
  const tree = useMemo(() => {
    if (!q) return buildTree(files, startIndex);
    const kept = files
      .map((file, i) => ({ file, index: startIndex + i }))
      .filter((item) => item.file.path.toLowerCase().includes(q));
    if (kept.length === 0) return [];
    return buildTree(kept);
  }, [files, startIndex, q]);

  return (
    <div className="wd-tree-pane">
      <input
        className="wd-web-filter"
        type="search"
        placeholder="Filter files…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {tree.length === 0 ? (
        <p className="wd-web-empty-list">No matches.</p>
      ) : (
        <ul className="wd-tree-root">
          {tree.map((n, i) => (
            <TreeNodeView
              key={i}
              node={n}
              selectedAnchor={selectedAnchor ?? null}
              viewedAnchors={viewedAnchors}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function TreeNodeView({
  node,
  selectedAnchor,
  viewedAnchors,
}: {
  node: TreeNode;
  selectedAnchor: string | null;
  viewedAnchors?: Set<string>;
}) {
  if (node.kind === 'dir') {
    return (
      <li className="wd-tree-dir">
        <details open>
          <summary>
            <span className="wd-tree-caret"></span>
            {node.name}
          </summary>
          <ul>
            {node.children.map((c, i) => (
              <TreeNodeView
                key={i}
                node={c}
                selectedAnchor={selectedAnchor}
                viewedAnchors={viewedAnchors}
              />
            ))}
          </ul>
        </details>
      </li>
    );
  }
  const anchor = `wd-file-${node.index}`;
  const active = anchor === selectedAnchor;
  const viewed = viewedAnchors?.has(anchor) ?? false;
  const stats =
    node.file.added || node.file.deleted ? (
      <span className="wd-tree-stats">
        <span className="wd-add">+{node.file.added}</span>{' '}
        <span className="wd-del">-{node.file.deleted}</span>
      </span>
    ) : null;
  return (
    <li
      className={
        'wd-tree-file' +
        (active ? ' wd-tree-file-active' : '') +
        (viewed ? ' wd-tree-file-viewed' : '')
      }
    >
      <a
        href={`#${anchor}`}
        onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById(anchor);
          if (!el) return;
          // Update the URL hash so back/forward work, but jump instantly
          // — smooth scrolling for hundreds of files feels laggy and the
          // user explicitly asked for jump behavior.
          history.replaceState(null, '', `#${anchor}`);
          el.scrollIntoView({ block: 'start' });
        }}
        title={node.file.path}
      >
        <span className={`wd-tree-status wd-status-${node.file.status}`}>
          {STATUS_LETTER[node.file.status]}
        </span>
        <span className="wd-tree-name">{node.name}</span>
        {stats}
        {typeof node.file.coverage === 'number' && (
          <span
            className={`wd-coverage-badge wd-coverage-${
              node.file.coverage >= 80
                ? 'good'
                : node.file.coverage >= 50
                  ? 'fair'
                  : 'poor'
            }`}
            title={`${Math.round(node.file.coverage)}% line coverage`}
          >
            {Math.round(node.file.coverage)}%
          </span>
        )}
      </a>
    </li>
  );
}
