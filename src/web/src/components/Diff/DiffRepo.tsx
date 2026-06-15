import { useMemo } from 'react';
import type { RepoData } from '../../api/client.js';
import { buildTree, flattenTreeFiles } from '../../utils/tree.js';
import { DiffFile } from './DiffFile.js';

interface Props {
  repo: RepoData;
  /** Globally-unique starting index for anchor ids across all repos in the session. */
  startIndex: number;
  /** Render with the review overlay (clickable line numbers, inline composers, comments). */
  review?: boolean;
  /** Paths of files in this repo currently marked viewed. */
  viewedPaths?: Set<string>;
  /** Called when the user toggles a file's viewed checkbox. */
  onToggleViewed?: (path: string, next: boolean) => void;
  /** Scope key for per-hunk reviewed state. Threaded down to each file. */
  hunkScopeKey?: string;
}

export function DiffRepo({
  repo,
  startIndex,
  review,
  viewedPaths,
  onToggleViewed,
  hunkScopeKey,
}: Props) {
  // Render files in the same directory-grouped, alphabetical order the
  // sidebar tree uses (GitHub-style) so the left tree and the right diff
  // list read top-to-bottom in lockstep. Each leaf keeps its ORIGINAL anchor
  // index (`startIndex + position in repo.files`) — the tree assigns the same
  // index via buildTree, so the tree↔diff anchor links stay correct even
  // though the visual order differs from git's raw diff order.
  //
  // Memoized on (files, startIndex): ReviewApp re-renders on every scrollspy
  // tick, and rebuilding the whole tree each time is wasted work for a large
  // diff. Mirrors FileTree, which memoizes the same buildTree call. The hook
  // runs before the empty-list early return (rules of hooks).
  const ordered = useMemo(
    () => flattenTreeFiles(buildTree(repo.files, startIndex)),
    [repo.files, startIndex],
  );
  if (repo.files.length === 0) {
    return (
      <div className="wd-web-empty">
        No changes in <code>{repo.name}</code>.
      </div>
    );
  }
  return (
    <div className="wd-repo-files">
      {ordered.map((leaf) => (
        <DiffFile
          key={leaf.file.path}
          file={leaf.file}
          anchor={`wd-file-${leaf.index}`}
          review={review}
          repo={repo.name}
          viewed={viewedPaths?.has(leaf.file.path)}
          onToggleViewed={
            onToggleViewed
              ? (next: boolean) => onToggleViewed(leaf.file.path, next)
              : undefined
          }
          hunkScopeKey={hunkScopeKey}
        />
      ))}
    </div>
  );
}
