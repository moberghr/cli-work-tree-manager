import { Fragment, type ReactNode } from 'react';
import { folderParts, proseParts } from '../../../../state/review-view.js';

/** The AI step's prose: plain text, what it put between backticks drawn as code. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {proseParts(text).map((p, k) =>
        p.code ? (
          <code key={k} className="wd-review-code">
            {p.text}
          </code>
        ) : (
          <Fragment key={k}>{p.text}</Fragment>
        ),
      )}
    </>
  );
}

/** A folder, dimmed, wrapping only after a `/` (never inside a folder's name). */
export function FolderPath({ folder, prefix }: { folder: string; prefix?: ReactNode }) {
  return (
    <span className="wd-review-folder">
      {prefix}
      {folderParts(folder).map((part, k) => (
        <Fragment key={k}>
          {k > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

/** "What changed here": the AI step's few sentences on a file, above its code; folds to its heading. */
export function FileSummary({ summary }: { summary: string }) {
  return (
    <details className="wd-review-file-summary" open>
      <summary>What changed here</summary>
      <p>
        <Prose text={summary} />
      </p>
    </details>
  );
}
