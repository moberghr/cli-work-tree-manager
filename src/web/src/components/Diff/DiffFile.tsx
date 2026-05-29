import type { FileStatus, ParsedFile } from '../../api/client.js';
import { DiffHunk } from './DiffHunk.js';

const STATUS_LETTER: Record<FileStatus, string> = {
  added: 'A',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  binary: 'B',
};

interface Props {
  file: ParsedFile;
  anchor: string;
  review?: boolean;
  repo?: string;
}

export function DiffFile({ file, anchor, review, repo }: Props) {
  const renamed =
    file.status === 'renamed' && file.oldPath !== file.newPath ? (
      <span className="wd-rename">
        {file.oldPath} → {file.newPath}
      </span>
    ) : null;
  return (
    <article
      className="wd-file"
      id={anchor}
      data-status={file.status}
      data-path={file.path}
    >
      <header className="wd-file-header">
        <span className={`wd-file-badge wd-status-${file.status}`}>
          {STATUS_LETTER[file.status]}
        </span>
        <span className="wd-file-path">{renamed ?? file.path}</span>
        {(file.added || file.deleted) && (
          <span className="wd-file-stats">
            <span className="wd-add">+{file.added}</span>{' '}
            <span className="wd-del">-{file.deleted}</span>
          </span>
        )}
      </header>
      {file.isBinary ? (
        <div className="wd-binary">Binary file</div>
      ) : file.hunks.length === 0 ? (
        <div className="wd-binary">No content changes</div>
      ) : (
        <table className="wd-diff-table wd-side">
          <colgroup>
            <col className="wd-col-ln" />
            <col className="wd-col-content" />
            <col className="wd-col-ln" />
            <col className="wd-col-content" />
          </colgroup>
          <tbody>
            {file.hunks.map((h, i) => (
              <DiffHunk
                hunk={h}
                key={i}
                review={review}
                repo={repo}
                file={file.path}
              />
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}
