import type { RepoData } from '../../api/client.js';
import { DiffFile } from './DiffFile.js';

interface Props {
  repo: RepoData;
  /** Globally-unique starting index for anchor ids across all repos in the session. */
  startIndex: number;
  /** Render with the review overlay (clickable line numbers, inline composers, comments). */
  review?: boolean;
}

export function DiffRepo({ repo, startIndex, review }: Props) {
  if (repo.files.length === 0) {
    return (
      <div className="wd-web-empty">
        No changes in <code>{repo.name}</code>.
      </div>
    );
  }
  return (
    <div className="wd-repo-files">
      {repo.files.map((f, i) => (
        <DiffFile
          key={f.path}
          file={f}
          anchor={`wd-file-${startIndex + i}`}
          review={review}
          repo={repo.name}
        />
      ))}
    </div>
  );
}
